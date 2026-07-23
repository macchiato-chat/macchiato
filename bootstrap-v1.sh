#!/usr/bin/env bash
# Macchiato connector verified bootstrap v1.
#
# This file is NEVER meant to be piped to a shell. The official web/iOS clients
# pin its exact SHA-256 and present a download → verify → execute command. Once
# its own bytes are pinned, this bootstrap verifies the signed release manifest,
# the whole compressed artifact, and every archive member before install.sh runs.
set -euo pipefail
# `bash -p` in every supported caller ignores inherited exported functions and
# SHELLOPTS before this file starts. Clear any functions again for direct/manual
# invocations so later helper names cannot be shadowed.
while IFS= read -r inherited_function; do
  builtin unset -f "$inherited_function"
done < <(builtin compgen -A function)
export LC_ALL=C
# Verification must not inherit language/runtime/config hooks that execute before
# our checked code. The updater also launches us with a minimal allowlist; this
# second boundary protects direct first installs from stale shell environments.
unset BASH_ENV ENV CDPATH GLOBIGNORE NODE_OPTIONS NODE_PATH \
  PYTHONPATH PYTHONHOME PYTHONSTARTUP TAR_OPTIONS GZIP BZIP BZIP2 XZ_OPT \
  RUBYOPT RUBYLIB PERL5OPT PERL5LIB CURL_HOME \
  LD_PRELOAD LD_LIBRARY_PATH DYLD_INSERT_LIBRARIES DYLD_LIBRARY_PATH \
  2>/dev/null || true

readonly BOOTSTRAP_VERSION=1
readonly RELEASE_KEY_ID="release-2026-07"
readonly RELEASE_PUBKEY_HEX="48d741eac2364340cfbd14502eac7506f8babcd4ce502775e831abcd1ed0f105"
readonly TEST_OVERRIDES_ENABLED=0
readonly MAX_MANIFEST_BYTES=1048576
readonly MAX_SIGNATURE_BYTES=1024
readonly MAX_ARTIFACT_BYTES=67108864
readonly MAX_UNPACKED_BYTES=134217728

say()  { printf '\033[1;35m[macchiato bootstrap]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[macchiato bootstrap] FAIL:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Macchiato verified connector bootstrap

This file must first be downloaded and SHA-256 checked against the value shown
by the Macchiato app or https://macchiato.chat. Do not pipe it to a shell.

Required:
  --release=X.Y.Z
  --bootstrap-sha256=<64 lowercase hex characters>

All other installer options (--agents, --mirror, --no-mirror, -y) are forwarded
to the already-verified install.sh.
EOF
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    fail "sha256sum or shasum is required"
  fi
}

size_of() {
  wc -c < "$1" | tr -d '[:space:]'
}

RELEASE=""
EXPECTED_BOOTSTRAP_SHA=""
FORWARD=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --release=*) RELEASE="${1#*=}" ;;
    --release)
      shift
      [ "$#" -gt 0 ] || fail "--release needs a value"
      RELEASE="$1"
      ;;
    --bootstrap-sha256=*) EXPECTED_BOOTSTRAP_SHA="${1#*=}" ;;
    --bootstrap-sha256)
      shift
      [ "$#" -gt 0 ] || fail "--bootstrap-sha256 needs a value"
      EXPECTED_BOOTSTRAP_SHA="$1"
      ;;
    --bootstrap-help|-h|--help)
      usage
      exit 0
      ;;
    --) shift; while [ "$#" -gt 0 ]; do FORWARD+=("$1"); shift; done; break ;;
    *) FORWARD+=("$1") ;;
  esac
  shift
done

[[ "$RELEASE" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] \
  || fail "invalid or missing --release=X.Y.Z"
[[ "$EXPECTED_BOOTSTRAP_SHA" =~ ^[0-9a-f]{64}$ ]] \
  || fail "invalid or missing --bootstrap-sha256"

SCRIPT_PATH="${BASH_SOURCE[0]}"
[ -f "$SCRIPT_PATH" ] && [ ! -L "$SCRIPT_PATH" ] \
  || fail "bootstrap must be executed from a downloaded regular file (not stdin/symlink)"
ACTUAL_BOOTSTRAP_SHA="$(sha256_of "$SCRIPT_PATH")"
[ "$ACTUAL_BOOTSTRAP_SHA" = "$EXPECTED_BOOTSTRAP_SHA" ] \
  || fail "bootstrap sha256 mismatch (expected $EXPECTED_BOOTSTRAP_SHA, got $ACTUAL_BOOTSTRAP_SHA)"

umask 077
WORK="$(mktemp -d "${TMPDIR:-/tmp}/macchiato-bootstrap.XXXXXX")" \
  || fail "cannot create private temporary directory"
cleanup() {
  chmod -R u+rwX "$WORK" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT HUP INT TERM

CURL_TLS=(--disable --silent --show-error --fail --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120)
if [ "${MACCHIATO_BOOTSTRAP_TESTING:-0}" = "1" ]; then
  [ "$TEST_OVERRIDES_ENABLED" = "1" ] \
    || fail "test overrides are disabled in the production bootstrap"
  BASE="${MACCHIATO_BOOTSTRAP_TEST_BASE:-}"
  [[ "$BASE" =~ ^https://[^/]+$ ]] || fail "test base must be a bare https origin"
  PUBKEY_HEX="${MACCHIATO_BOOTSTRAP_TEST_PUBKEY_HEX:-}"
  KEY_ID="${MACCHIATO_BOOTSTRAP_TEST_KEY_ID:-$RELEASE_KEY_ID}"
  [ -n "${MACCHIATO_BOOTSTRAP_TEST_CACERT:-}" ] \
    && CURL_TLS+=(--cacert "$MACCHIATO_BOOTSTRAP_TEST_CACERT")
  MANIFEST_URL="${MACCHIATO_BOOTSTRAP_TEST_MANIFEST_URL:-$BASE/release-v2.json}"
  SIGNATURE_URL="${MACCHIATO_BOOTSTRAP_TEST_SIGNATURE_URL:-$BASE/release-v2.json.sig}"
else
  BASE="https://raw.githubusercontent.com/macchiato-chat/macchiato/connectors-v$RELEASE"
  PUBKEY_HEX="$RELEASE_PUBKEY_HEX"
  KEY_ID="$RELEASE_KEY_ID"
  MANIFEST_URL="$BASE/release-v2.json"
  SIGNATURE_URL="$BASE/release-v2.json.sig"
fi
[[ "$PUBKEY_HEX" =~ ^[0-9a-f]{64}$ ]] || fail "invalid embedded release public key"

download_no_redirect() { # url destination max-bytes label
  local url="$1" destination="$2" maximum="$3" label="$4" actual status
  status="$(
    command curl "${CURL_TLS[@]}" --max-redirs 0 --max-filesize "$maximum" \
      --output "$destination" --write-out '%{http_code}' "$url"
  )" \
    || fail "$label download failed (redirects are forbidden)"
  [ "$status" = "200" ] \
    || fail "$label download failed (HTTP $status; redirects are forbidden)"
  actual="$(size_of "$destination")"
  [ "$actual" -le "$maximum" ] || fail "$label exceeds $maximum bytes"
}

MANIFEST="$WORK/release-v2.json"
SIGNATURE="$WORK/release-v2.json.sig"
download_no_redirect "$MANIFEST_URL" "$MANIFEST" "$MAX_MANIFEST_BYTES" "manifest"
download_no_redirect "$SIGNATURE_URL" "$SIGNATURE" "$MAX_SIGNATURE_BYTES" "signature"

META="$WORK/meta"
EXPECTED_FILES="$WORK/expected-files.tsv"

verify_with_node() {
  command node - "$MANIFEST" "$SIGNATURE" "$PUBKEY_HEX" "$KEY_ID" "$RELEASE" "$META" "$EXPECTED_FILES" <<'NODE'
const { createPublicKey, verify } = require("node:crypto");
const { readFileSync, writeFileSync } = require("node:fs");
const [manifestPath, signaturePath, pubkeyHex, keyId, expectedVersion, metaPath, filesPath] =
  process.argv.slice(2);
const die = (message) => { throw new Error(message); };
const bytes = readFileSync(manifestPath);
const signatureText = readFileSync(signaturePath, "utf8");
if (!/^[A-Za-z0-9+/]{86}==\n?$/.test(signatureText)) die("invalid signature encoding");
const raw = Buffer.from(pubkeyHex, "hex");
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
  format: "der",
  type: "spki",
});
if (!verify(null, bytes, key, Buffer.from(signatureText.trim(), "base64"))) {
  die("release-v2 signature verification failed");
}
const m = JSON.parse(bytes.toString("utf8"));
const canonical = Buffer.from(`${JSON.stringify(m, null, 2)}\n`);
if (!canonical.equals(bytes)) die("manifest is not canonical JSON (duplicate keys/alternate encoding forbidden)");
const exactKeys = (object, expected, label) => {
  if (!object || typeof object !== "object" || Array.isArray(object)) die(`${label} must be an object`);
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, i) => key !== wanted[i])) {
    die(`${label} has unknown/missing keys`);
  }
};
exactKeys(m, ["schema", "keyId", "version", "sequence", "createdAt", "artifact", "files", "fileSizes"], "manifest");
exactKeys(m.artifact, ["name", "size", "sha256"], "artifact");
if (m.schema !== 2 || m.keyId !== keyId || m.version !== expectedVersion) die("schema/key/version mismatch");
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(m.version)) die("invalid version");
const p = m.version.split(".").map(Number);
if (p.some((value) => !Number.isSafeInteger(value) || value >= 1_000_000)) die("version out of range");
const sequence = p[0] * 1_000_000_000_000 + p[1] * 1_000_000 + p[2];
if (!Number.isSafeInteger(m.sequence) || m.sequence !== sequence) die("release sequence mismatch/downgrade");
if (typeof m.createdAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(m.createdAt)) die("invalid createdAt");
if (m.artifact.name !== `macchiato-connectors-${m.version}.tar.gz`) die("artifact name mismatch");
if (!Number.isSafeInteger(m.artifact.size) || m.artifact.size <= 0 || m.artifact.size > 67108864) die("artifact size out of range");
if (!/^[0-9a-f]{64}$/.test(m.artifact.sha256)) die("invalid artifact sha256");
exactKeys(m.files, Object.keys(m.fileSizes), "files/fileSizes");
const paths = Object.keys(m.files).sort();
if (paths.length === 0 || paths.length > 10000) die("invalid file inventory size");
const seenFolded = new Set();
const safePath = /^[A-Za-z0-9._+@/-]+$/;
const lines = [];
let totalSize = 0;
for (const path of paths) {
  if (!safePath.test(path) || path.startsWith("/") || path.includes("//") ||
      path.split("/").some((part) => part === "." || part === "..")) die(`unsafe path: ${path}`);
  const folded = path.toLowerCase();
  if (seenFolded.has(folded)) die(`case-fold path collision: ${path}`);
  seenFolded.add(folded);
  if (!/^[0-9a-f]{64}$/.test(m.files[path])) die(`invalid file sha256: ${path}`);
  if (!Number.isSafeInteger(m.fileSizes[path]) || m.fileSizes[path] < 0 || m.fileSizes[path] > 67108864) {
    die(`invalid file size: ${path}`);
  }
  totalSize += m.fileSizes[path];
  if (!Number.isSafeInteger(totalSize) || totalSize > 134217728) die("unpacked file inventory exceeds 128 MiB");
  lines.push(`${path}\t${m.files[path]}\t${m.fileSizes[path]}`);
}
if (!Object.prototype.hasOwnProperty.call(m.files, "install.sh")) die("install.sh missing from inventory");
writeFileSync(metaPath, `${m.artifact.name}\n${m.artifact.size}\n${m.artifact.sha256}\n`);
writeFileSync(filesPath, `${lines.join("\n")}\n`);
NODE
}

verify_with_python() {
  (
  cd "$WORK"
  command python3 -I - "$MANIFEST" "$SIGNATURE" "$PUBKEY_HEX" "$KEY_ID" "$RELEASE" "$META" "$EXPECTED_FILES" <<'PY'
import base64, hashlib, json, re, sys
manifest_path, signature_path, pub_hex, key_id, expected_version, meta_path, files_path = sys.argv[1:]
p = 2**255 - 19
L = 2**252 + 27742317777372353535851937790883648493
d = (-121665 * pow(121666, p - 2, p)) % p
sqrt_m1 = pow(2, (p - 1) // 4, p)
def recover_x(y, sign):
    if y >= p: return None
    x2 = (y*y - 1) * pow(d*y*y + 1, p - 2, p) % p
    if x2 == 0: return None if sign else 0
    x = pow(x2, (p + 3) // 8, p)
    if (x*x - x2) % p: x = x * sqrt_m1 % p
    if (x*x - x2) % p: return None
    return p - x if (x & 1) != sign else x
gy = 4 * pow(5, p - 2, p) % p
gx = recover_x(gy, 0)
G = (gx, gy, 1, gx * gy % p)
def add(P, Q):
    A=(P[1]-P[0])*(Q[1]-Q[0])%p; B=(P[1]+P[0])*(Q[1]+Q[0])%p
    C=2*P[3]*Q[3]*d%p; D=2*P[2]*Q[2]%p
    E,F,Gv,H=B-A,D-C,D+C,B+A
    return (E*F%p,Gv*H%p,F*Gv%p,E*H%p)
def mul(s, P):
    Q=(0,1,1,0)
    while s:
        if s & 1: Q=add(Q,P)
        P=add(P,P); s >>= 1
    return Q
def eq(P,Q):
    return (P[0]*Q[2]-Q[0]*P[2])%p == 0 and (P[1]*Q[2]-Q[1]*P[2])%p == 0
def dec(data):
    if len(data) != 32: return None
    y=int.from_bytes(data,"little"); sign=y>>255; y &= (1<<255)-1
    x=recover_x(y,sign)
    return None if x is None else (x,y,1,x*y%p)
def edverify(public,msg,sig):
    if len(public)!=32 or len(sig)!=64: return False
    A=dec(public); R=dec(sig[:32]); s=int.from_bytes(sig[32:],"little")
    if A is None or R is None or s>=L: return False
    h=int.from_bytes(hashlib.sha512(sig[:32]+public+msg).digest(),"little")%L
    return eq(mul(s,G),add(R,mul(h,A)))
def pairs(pairs):
    obj={}
    for key,value in pairs:
        if key in obj: raise ValueError("duplicate JSON key")
        obj[key]=value
    return obj
raw=open(manifest_path,"rb").read()
sig_text=open(signature_path,"r",encoding="ascii").read()
if not re.fullmatch(r"[A-Za-z0-9+/]{86}==\n?",sig_text): raise ValueError("invalid signature encoding")
if not edverify(bytes.fromhex(pub_hex),raw,base64.b64decode(sig_text.strip())):
    raise ValueError("release-v2 signature verification failed")
m=json.loads(raw,object_pairs_hook=pairs)
def exact(obj, names, label):
    if not isinstance(obj,dict) or set(obj) != set(names): raise ValueError(label+" has unknown/missing keys")
exact(m,["schema","keyId","version","sequence","createdAt","artifact","files","fileSizes"],"manifest")
exact(m["artifact"],["name","size","sha256"],"artifact")
if m["schema"]!=2 or m["keyId"]!=key_id or m["version"]!=expected_version: raise ValueError("schema/key/version mismatch")
if not re.fullmatch(r"(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)",m["version"]): raise ValueError("invalid version")
parts=[int(x) for x in m["version"].split(".")]
if any(x>=1_000_000 for x in parts): raise ValueError("version out of range")
sequence=parts[0]*1_000_000_000_000+parts[1]*1_000_000+parts[2]
if sequence > 9007199254740991 or type(m["sequence"]) is not int or m["sequence"]!=sequence: raise ValueError("release sequence mismatch/downgrade")
if not isinstance(m["createdAt"],str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z",m["createdAt"]): raise ValueError("invalid createdAt")
a=m["artifact"]
if a["name"] != "macchiato-connectors-"+m["version"]+".tar.gz": raise ValueError("artifact name mismatch")
if type(a["size"]) is not int or not 0<a["size"]<=67108864: raise ValueError("artifact size out of range")
if not isinstance(a["sha256"],str) or not re.fullmatch(r"[0-9a-f]{64}",a["sha256"]): raise ValueError("invalid artifact sha256")
if not isinstance(m["files"],dict) or not isinstance(m["fileSizes"],dict) or set(m["files"])!=set(m["fileSizes"]): raise ValueError("files/fileSizes mismatch")
paths=sorted(m["files"])
if not 0<len(paths)<=10000: raise ValueError("invalid file inventory size")
folded=set(); lines=[]; total_size=0
for path in paths:
    if (not re.fullmatch(r"[A-Za-z0-9._+@/-]+",path) or path.startswith("/") or "//" in path
        or any(part in (".","..") for part in path.split("/"))): raise ValueError("unsafe path: "+path)
    low=path.lower()
    if low in folded: raise ValueError("case-fold path collision: "+path)
    folded.add(low)
    digest=m["files"][path]; size=m["fileSizes"][path]
    if not isinstance(digest,str) or not re.fullmatch(r"[0-9a-f]{64}",digest): raise ValueError("invalid file sha256")
    if type(size) is not int or not 0<=size<=67108864: raise ValueError("invalid file size")
    total_size += size
    if total_size > 134217728: raise ValueError("unpacked file inventory exceeds 128 MiB")
    lines.append(f"{path}\t{digest}\t{size}")
if "install.sh" not in m["files"]: raise ValueError("install.sh missing")
open(meta_path,"w").write(f'{a["name"]}\n{a["size"]}\n{a["sha256"]}\n')
open(files_path,"w").write("\n".join(lines)+"\n")
PY
  )
}

RUNTIME="${MACCHIATO_BOOTSTRAP_RUNTIME:-auto}"
VERIFIER=""
case "$RUNTIME" in
  auto)
    if type -P node >/dev/null 2>&1; then VERIFIER=node; verify_with_node
    elif type -P python3 >/dev/null 2>&1; then VERIFIER=python; verify_with_python
    else fail "Node.js or Python 3 is required to verify the Ed25519 release signature"
    fi
    ;;
  node) type -P node >/dev/null 2>&1 || fail "node runtime requested but unavailable"; VERIFIER=node; verify_with_node ;;
  python) type -P python3 >/dev/null 2>&1 || fail "python runtime requested but unavailable"; VERIFIER=python; verify_with_python ;;
  *) fail "invalid verifier runtime" ;;
esac

ARTIFACT_NAME="$(sed -n '1p' "$META")"
ARTIFACT_SIZE="$(sed -n '2p' "$META")"
ARTIFACT_SHA="$(sed -n '3p' "$META")"
[[ "$ARTIFACT_SIZE" =~ ^[0-9]+$ ]] && [ "$ARTIFACT_SIZE" -le "$MAX_ARTIFACT_BYTES" ] \
  || fail "verified artifact size is invalid"

if [ "${MACCHIATO_BOOTSTRAP_TESTING:-0}" = "1" ]; then
  ARTIFACT_URL="${MACCHIATO_BOOTSTRAP_TEST_ARTIFACT_URL:-$BASE/$ARTIFACT_NAME}"
else
  ARTIFACT_URL="https://github.com/macchiato-chat/macchiato/releases/download/connectors-v$RELEASE/$ARTIFACT_NAME"
fi

validate_artifact_url() {
  local candidate="$1"
  if [ "${MACCHIATO_BOOTSTRAP_TESTING:-0}" = "1" ]; then
    case "$candidate" in "$BASE"/*) return 0 ;; esac
    fail "artifact redirect target left the pinned test origin before request: $candidate"
  fi
  case "$candidate" in
    "https://github.com/macchiato-chat/macchiato/releases/download/"*|\
    "https://release-assets.githubusercontent.com/"*|\
    "https://objects.githubusercontent.com/"*) return 0 ;;
    *) fail "artifact URL uses an untrusted origin before request: $candidate" ;;
  esac
}

ARTIFACT="$WORK/$ARTIFACT_NAME"
ARTIFACT_PART="$WORK/artifact.download"
CURRENT_URL="$ARTIFACT_URL"
ARTIFACT_DONE=0
for hop in 0 1 2 3; do
  validate_artifact_url "$CURRENT_URL"
  RESULT="$(
    command curl "${CURL_TLS[@]}" --max-redirs 0 --max-filesize "$ARTIFACT_SIZE" \
      --output "$ARTIFACT_PART" --write-out $'%{http_code}\t%{redirect_url}' "$CURRENT_URL"
  )" || fail "artifact download failed"
  STATUS="${RESULT%%$'\t'*}"
  REDIRECT_URL="${RESULT#*$'\t'}"
  if [ "$STATUS" = "200" ]; then
    [ -z "$REDIRECT_URL" ] || fail "artifact 200 response unexpectedly advertised a redirect"
    mv "$ARTIFACT_PART" "$ARTIFACT"
    ARTIFACT_DONE=1
    break
  fi
  case "$STATUS" in 301|302|303|307|308) ;; *) fail "artifact download failed (HTTP $STATUS)" ;; esac
  [ "$hop" -lt 3 ] || fail "artifact redirect limit exceeded"
  [ -n "$REDIRECT_URL" ] || fail "artifact redirect missing a resolvable Location"
  validate_artifact_url "$REDIRECT_URL"
  CURRENT_URL="$REDIRECT_URL"
done
[ "$ARTIFACT_DONE" = "1" ] || fail "artifact download did not reach HTTP 200"
[ "$(size_of "$ARTIFACT")" = "$ARTIFACT_SIZE" ] || fail "artifact size mismatch"
[ "$(sha256_of "$ARTIFACT")" = "$ARTIFACT_SHA" ] || fail "artifact sha256 mismatch"

EXTRACTED="$WORK/extracted"
mkdir -m 700 "$EXTRACTED"

extract_with_node() {
  command node - "$ARTIFACT" "$EXPECTED_FILES" "$EXTRACTED" <<'NODE'
const { createHash } = require("node:crypto");
const { dirname, join } = require("node:path");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { gunzipSync } = require("node:zlib");
const [artifactPath, expectedPath, root] = process.argv.slice(2);
const MAX_TAR_BYTES = 160 * 1024 * 1024;
const die = (message) => { throw new Error(message); };
const safePath = /^[A-Za-z0-9._+@/-]+$/;
const expected = new Map();
for (const line of readFileSync(expectedPath, "utf8").trimEnd().split("\n")) {
  const fields = line.split("\t");
  if (fields.length !== 3) die("invalid signed inventory row");
  const [path, digest, sizeText] = fields;
  const size = Number(sizeText);
  if (expected.has(path) || !Number.isSafeInteger(size) || size < 0) die("invalid signed inventory");
  expected.set(path, { digest, size });
}
let tar;
try {
  tar = gunzipSync(readFileSync(artifactPath), { maxOutputLength: MAX_TAR_BYTES + 1 });
} catch (error) {
  die(`artifact gzip decode failed: ${error.message}`);
}
if (tar.length > MAX_TAR_BYTES) die("artifact tar exceeds 160 MiB");
const fieldText = (header, start, length, label) => {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const end = nul < 0 ? field.length : nul;
  if (nul >= 0 && field.subarray(nul).some((byte) => byte !== 0)) die(`${label} has bytes after NUL`);
  return field.subarray(0, end).toString("utf8");
};
const octal = (header, start, length, label) => {
  const text = header.subarray(start, start + length).toString("ascii").replace(/[\0 ]+$/g, "");
  if (!/^[0-7]+$/.test(text)) die(`${label} is not strict octal`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) die(`${label} overflows`);
  return value;
};
let offset = 0;
const seen = new Set();
const folded = new Set();
while (offset + 512 <= tar.length) {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) break;
  const checksumHeader = Buffer.from(header);
  checksumHeader.fill(0x20, 148, 156);
  const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
  if (octal(header, 148, 8, "tar checksum") !== actualChecksum) die("tar header checksum mismatch");
  if (!header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
      !header.subarray(263, 265).equals(Buffer.from("00"))) die("non-ustar archive is forbidden");
  const type = header[156];
  if (type !== 0 && type !== 0x30) die("artifact contains a non-regular entry");
  const name = fieldText(header, 0, 100, "tar name");
  const prefix = fieldText(header, 345, 155, "tar prefix");
  const path = prefix ? `${prefix}/${name}` : name;
  if (!safePath.test(path) || path.startsWith("/") || path.includes("//") ||
      path.split("/").some((part) => part === "." || part === "..")) die(`unsafe archive member path: ${path}`);
  const low = path.toLowerCase();
  if (seen.has(path) || folded.has(low)) die(`duplicate/case-fold archive path: ${path}`);
  seen.add(path); folded.add(low);
  const signed = expected.get(path);
  if (!signed) die(`artifact contains unknown file: ${path}`);
  const size = octal(header, 124, 12, "tar size");
  if (size !== signed.size) die(`tar header size differs from signed size: ${path}`);
  const contentStart = offset + 512;
  const contentEnd = contentStart + size;
  const next = contentStart + Math.ceil(size / 512) * 512;
  if (contentEnd > tar.length || next > tar.length) die(`truncated tar member: ${path}`);
  if (tar.subarray(contentEnd, next).some((byte) => byte !== 0)) die(`non-zero tar padding: ${path}`);
  const content = tar.subarray(contentStart, contentEnd);
  const digest = createHash("sha256").update(content).digest("hex");
  if (digest !== signed.digest) die(`file sha256 mismatch before extraction: ${path}`);
  const destination = join(root, ...path.split("/"));
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  writeFileSync(destination, content, { flag: "wx", mode: path === "install.sh" ? 0o700 : 0o600 });
  offset = next;
}
const trailer = tar.subarray(offset);
if (trailer.length !== 1024 || trailer.some((byte) => byte !== 0)) {
  die("tar must end with exactly two zero blocks and no trailing data");
}
if (seen.size !== expected.size) die("artifact is missing signed files");
NODE
}

extract_with_python() {
  (
  cd "$WORK"
  command python3 -I - "$ARTIFACT" "$EXPECTED_FILES" "$EXTRACTED" <<'PY'
import gzip, hashlib, os, re, sys
artifact_path, expected_path, root = sys.argv[1:]
MAX_TAR_BYTES = 160 * 1024 * 1024
safe_path = re.compile(r"^[A-Za-z0-9._+@/-]+$")
expected = {}
with open(expected_path, "r", encoding="utf-8") as handle:
    for raw_line in handle:
        fields = raw_line.rstrip("\n").split("\t")
        if len(fields) != 3: raise ValueError("invalid signed inventory row")
        path, digest, size_text = fields
        if path in expected or not size_text.isdigit(): raise ValueError("invalid signed inventory")
        expected[path] = (digest, int(size_text))
with gzip.open(artifact_path, "rb") as handle:
    tar = handle.read(MAX_TAR_BYTES + 1)
    if len(tar) > MAX_TAR_BYTES or handle.read(1): raise ValueError("artifact tar exceeds 160 MiB")
def field_text(header, start, length, label):
    field = header[start:start+length]
    nul = field.find(b"\0")
    end = len(field) if nul < 0 else nul
    if nul >= 0 and any(field[nul:]): raise ValueError(label+" has bytes after NUL")
    return field[:end].decode("utf-8")
def octal(header, start, length, label):
    text = header[start:start+length].decode("ascii").rstrip("\0 ")
    if not re.fullmatch(r"[0-7]+", text): raise ValueError(label+" is not strict octal")
    return int(text, 8)
offset = 0
seen = set()
folded = set()
while offset + 512 <= len(tar):
    header = tar[offset:offset+512]
    if not any(header): break
    checksum_header = bytearray(header)
    checksum_header[148:156] = b" " * 8
    if octal(header, 148, 8, "tar checksum") != sum(checksum_header):
        raise ValueError("tar header checksum mismatch")
    if header[257:263] != b"ustar\0" or header[263:265] != b"00":
        raise ValueError("non-ustar archive is forbidden")
    if header[156] not in (0, 0x30): raise ValueError("artifact contains a non-regular entry")
    name = field_text(header, 0, 100, "tar name")
    prefix = field_text(header, 345, 155, "tar prefix")
    path = prefix+"/"+name if prefix else name
    if (not safe_path.fullmatch(path) or path.startswith("/") or "//" in path
        or any(part in (".", "..") for part in path.split("/"))):
        raise ValueError("unsafe archive member path: "+path)
    low = path.lower()
    if path in seen or low in folded: raise ValueError("duplicate/case-fold archive path: "+path)
    seen.add(path); folded.add(low)
    if path not in expected: raise ValueError("artifact contains unknown file: "+path)
    digest, signed_size = expected[path]
    size = octal(header, 124, 12, "tar size")
    if size != signed_size: raise ValueError("tar header size differs from signed size: "+path)
    content_start = offset + 512
    content_end = content_start + size
    next_offset = content_start + ((size + 511) // 512) * 512
    if content_end > len(tar) or next_offset > len(tar): raise ValueError("truncated tar member: "+path)
    if any(tar[content_end:next_offset]): raise ValueError("non-zero tar padding: "+path)
    content = tar[content_start:content_end]
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("file sha256 mismatch before extraction: "+path)
    destination = os.path.join(root, *path.split("/"))
    os.makedirs(os.path.dirname(destination), mode=0o700, exist_ok=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"): flags |= os.O_NOFOLLOW
    fd = os.open(destination, flags, 0o700 if path == "install.sh" else 0o600)
    try:
        with os.fdopen(fd, "wb", closefd=False) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
    finally:
        os.close(fd)
    offset = next_offset
trailer = tar[offset:]
if len(trailer) != 1024 or any(trailer):
    raise ValueError("tar must end with exactly two zero blocks and no trailing data")
if len(seen) != len(expected): raise ValueError("artifact is missing signed files")
PY
  )
}

case "$VERIFIER" in
  node) extract_with_node || fail "strict ustar verification/extraction failed" ;;
  python) extract_with_python || fail "strict ustar verification/extraction failed" ;;
  *) fail "internal: verifier runtime not selected" ;;
esac

say "bootstrap, signature, version, artifact, and file inventory verified (v$RELEASE)"
if [ "${MACCHIATO_BOOTSTRAP_TESTING:-0}" = "1" ] \
  && [ "${MACCHIATO_BOOTSTRAP_TEST_VERIFY_ONLY:-0}" = "1" ]; then
  exit 0
fi
MACCHIATO_VERIFIED_ROOT="$EXTRACTED" \
MACCHIATO_MANIFEST="$MANIFEST" \
/bin/bash -p "$EXTRACTED/install.sh" ${FORWARD[@]+"${FORWARD[@]}"}

#!/usr/bin/env python3
"""
#832 終端 QR：純 Python、零依賴（不需要系統 qrencode / pip 包）。

配對 token 約 56 字符 → QR Version 4–5 即可。只做 byte mode + ECC M，
半高 Unicode 塊渲染，樣式對齊 TS 側 connector-core/linkb/qr-terminal.ts。
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Galois field GF(256) for Reed-Solomon (QR 用 0x11d 本原多項式)
# ---------------------------------------------------------------------------
_EXP = [0] * 512
_LOG = [0] * 256


def _init_gf() -> None:
    x = 1
    for i in range(255):
        _EXP[i] = x
        _LOG[x] = i
        x <<= 1
        if x & 0x100:
            x ^= 0x11D
    for i in range(255, 512):
        _EXP[i] = _EXP[i - 255]


_init_gf()


def _gf_mul(a: int, b: int) -> int:
    if a == 0 or b == 0:
        return 0
    return _EXP[_LOG[a] + _LOG[b]]


def _gf_pow(a: int, p: int) -> int:
    return _EXP[(_LOG[a] * p) % 255] if a else 0


def _poly_mul(p: list[int], q: list[int]) -> list[int]:
    out = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        for j, b in enumerate(q):
            out[i + j] ^= _gf_mul(a, b)
    return out


def _rs_generator(nsym: int) -> list[int]:
    g = [1]
    for i in range(nsym):
        g = _poly_mul(g, [1, _gf_pow(2, i)])
    return g


def _rs_encode(data: list[int], nsym: int) -> list[int]:
    gen = _rs_generator(nsym)
    out = data[:] + [0] * nsym
    for i in range(len(data)):
        coef = out[i]
        if coef != 0:
            for j in range(len(gen)):
                out[i + j] ^= _gf_mul(gen[j], coef)
    return out[-nsym:]


# ---------------------------------------------------------------------------
# QR ECC-M 塊表（byte mode）。只覆蓋配對 token 需要的版本 1–10。
# (ec_codewords_per_block, num_blocks_group1, data_codewords_group1,
#  num_blocks_group2, data_codewords_group2)
# ---------------------------------------------------------------------------
_EC_M = {
    1: (10, 1, 16, 0, 0),
    2: (16, 1, 28, 0, 0),
    3: (26, 1, 44, 0, 0),
    4: (18, 2, 32, 0, 0),
    5: (24, 2, 43, 0, 0),
    6: (16, 4, 27, 0, 0),
    7: (18, 4, 31, 0, 0),
    8: (22, 2, 38, 2, 39),
    9: (22, 3, 36, 2, 37),
    10: (26, 4, 43, 1, 44),
}

# Alignment pattern centers (version → list). Version 1 has none.
_ALIGN = {
    2: [6, 18],
    3: [6, 22],
    4: [6, 26],
    5: [6, 30],
    6: [6, 34],
    7: [6, 22, 38],
    8: [6, 24, 42],
    9: [6, 26, 46],
    10: [6, 28, 50],
}

# Format information (BCH + XOR 0x5412) for ECC level M, masks 0–7.
# 參考 ISO/IEC 18004 / thonky：M+mask0 = 0x5412。
_FORMAT_ECC_M = [
    0x5412,
    0x5125,
    0x5E7C,
    0x5B4B,
    0x45F9,
    0x40CE,
    0x4F97,
    0x4AA0,
]


def _format_bits(mask: int) -> int:
    return _FORMAT_ECC_M[mask]


def _version_info_bits(version: int) -> int:
    """Version information（v≥7 專有）：6 bit 版本號 + BCH(18,6) 的 12 bit 糾錯，生成多項式 0x1F25。

    ⚠️ 不寫這 18 bit 的後果不是「少了個可選欄位」——解碼器讀不到版本信息就直接放棄，
    整張碼變成廢碼（實測 v7/v8/v10 全部解不出，v1–v6 因為沒有這個區域反而正常）。
    """
    remainder = version << 12
    while remainder.bit_length() >= 13:
        remainder ^= 0x1F25 << (remainder.bit_length() - 13)
    return (version << 12) | remainder


def _set_version_info(m: list[list[int]], version: int) -> None:
    """把 18 bit 版本信息寫進左下 / 右上兩塊保留區（`_reserve` 已把它們佔住、不受掩碼影響）。"""
    if version < 7:
        return
    size = len(m)
    bits = _version_info_bits(version)
    for i in range(18):
        bit = (bits >> i) & 1
        m[i // 3][size - 11 + i % 3] = bit
        m[size - 11 + i % 3][i // 3] = bit


def _choose_version(data_len: int) -> int:
    # byte mode overhead: 4 mode + 8/16 count + data*8 + 4 terminator, padded to codewords
    # rough: need data_codewords >= ceil((4+8+data_len*8+4)/8) for v<=9 (8-bit count)
    need_bits = 4 + 8 + data_len * 8 + 4
    need_cw = (need_bits + 7) // 8
    for v in range(1, 11):
        # total data codewords for ECC M
        ec_per, n1, d1, n2, d2 = _EC_M[v]
        data_cw = n1 * d1 + n2 * d2
        # version >= 10 uses 16-bit count
        if v >= 10:
            need_bits_v = 4 + 16 + data_len * 8 + 4
            need_cw = (need_bits_v + 7) // 8
        if data_cw >= need_cw:
            return v
    raise ValueError("data too long for QR versions 1–10")


def _encode_data(data: bytes, version: int) -> list[int]:
    ec_per, n1, d1, n2, d2 = _EC_M[version]
    data_cw = n1 * d1 + n2 * d2
    bits: list[int] = []

    def put(val: int, n: int) -> None:
        for i in range(n - 1, -1, -1):
            bits.append((val >> i) & 1)

    put(0b0100, 4)  # byte mode
    put(len(data), 16 if version >= 10 else 8)
    for b in data:
        put(b, 8)
    # terminator
    term = min(4, data_cw * 8 - len(bits))
    put(0, term)
    # pad to byte
    while len(bits) % 8:
        bits.append(0)
    codewords = []
    for i in range(0, len(bits), 8):
        byte = 0
        for j in range(8):
            byte = (byte << 1) | bits[i + j]
        codewords.append(byte)
    pad = [0xEC, 0x11]
    pi = 0
    while len(codewords) < data_cw:
        codewords.append(pad[pi % 2])
        pi += 1

    # Split into blocks, RS encode, interleave
    blocks_data: list[list[int]] = []
    blocks_ec: list[list[int]] = []
    offset = 0
    for _ in range(n1):
        block = codewords[offset : offset + d1]
        offset += d1
        blocks_data.append(block)
        blocks_ec.append(_rs_encode(block, ec_per))
    for _ in range(n2):
        block = codewords[offset : offset + d2]
        offset += d2
        blocks_data.append(block)
        blocks_ec.append(_rs_encode(block, ec_per))

    result: list[int] = []
    max_d = max(len(b) for b in blocks_data)
    for i in range(max_d):
        for b in blocks_data:
            if i < len(b):
                result.append(b[i])
    for i in range(ec_per):
        for b in blocks_ec:
            result.append(b[i])
    return result


def _matrix_size(version: int) -> int:
    return 17 + 4 * version


def _reserve(size: int, version: int) -> list[list[int | None]]:
    """None = free, 0/1 = fixed module."""
    m: list[list[int | None]] = [[None] * size for _ in range(size)]

    def set_rect(r0: int, c0: int, r1: int, c1: int, val: int) -> None:
        for r in range(r0, r1):
            for c in range(c0, c1):
                if 0 <= r < size and 0 <= c < size:
                    m[r][c] = val

    def finder(r0: int, c0: int) -> None:
        set_rect(r0 - 1, c0 - 1, r0 + 8, c0 + 8, 0)  # separator + quiet-ish
        for r in range(7):
            for c in range(7):
                border = r in (0, 6) or c in (0, 6)
                inner = 2 <= r <= 4 and 2 <= c <= 4
                m[r0 + r][c0 + c] = 1 if (border or inner) else 0
        # clear separator explicitly
        for i in range(-1, 8):
            for rr, cc in ((r0 + i, c0 - 1), (r0 + i, c0 + 7), (r0 - 1, c0 + i), (r0 + 7, c0 + i)):
                if 0 <= rr < size and 0 <= cc < size and m[rr][cc] is None:
                    m[rr][cc] = 0
                elif 0 <= rr < size and 0 <= cc < size and not (0 <= rr - r0 < 7 and 0 <= cc - c0 < 7):
                    m[rr][cc] = 0

    # Finders
    for r in range(8):
        for c in range(8):
            m[r][c] = 0
            m[r][size - 8 + c] = 0
            m[size - 8 + r][c] = 0
    for r0, c0 in ((0, 0), (0, size - 7), (size - 7, 0)):
        for r in range(7):
            for c in range(7):
                border = r in (0, 6) or c in (0, 6)
                inner = 2 <= r <= 4 and 2 <= c <= 4
                m[r0 + r][c0 + c] = 1 if (border or inner) else 0

    # Timing
    for i in range(8, size - 8):
        m[6][i] = 1 if i % 2 == 0 else 0
        m[i][6] = 1 if i % 2 == 0 else 0

    # Alignment
    centers = _ALIGN.get(version, [])
    for r in centers:
        for c in centers:
            # skip if overlaps finder
            if (r < 9 and c < 9) or (r < 9 and c > size - 10) or (r > size - 10 and c < 9):
                continue
            for dr in range(-2, 3):
                for dc in range(-2, 3):
                    rr, cc = r + dr, c + dc
                    if abs(dr) == 2 or abs(dc) == 2 or (dr == 0 and dc == 0):
                        m[rr][cc] = 1
                    else:
                        m[rr][cc] = 0

    # Dark module
    m[size - 8][8] = 1

    # Format info reserved
    for i in range(9):
        if m[8][i] is None:
            m[8][i] = 0
        if m[i][8] is None:
            m[i][8] = 0
    for i in range(8):
        m[8][size - 1 - i] = 0
        m[size - 1 - i][8] = 0

    # Version info reserved (v>=7)
    if version >= 7:
        for i in range(6):
            for j in range(3):
                m[i][size - 11 + j] = 0
                m[size - 11 + j][i] = 0

    return m


def _place_data(m: list[list[int | None]], codewords: list[int]) -> None:
    size = len(m)
    bits: list[int] = []
    for cw in codewords:
        for i in range(7, -1, -1):
            bits.append((cw >> i) & 1)
    # remainder bits for some versions
    bi = 0
    col = size - 1
    upward = True
    while col > 0:
        if col == 6:
            col -= 1
        rows = range(size - 1, -1, -1) if upward else range(size)
        for row in rows:
            for c in (col, col - 1):
                if m[row][c] is None:
                    m[row][c] = bits[bi] if bi < len(bits) else 0
                    bi += 1
        upward = not upward
        col -= 2


def _apply_mask(m: list[list[int]], mask: int, reserved: list[list[bool]]) -> list[list[int]]:
    size = len(m)
    out = [row[:] for row in m]
    for r in range(size):
        for c in range(size):
            if reserved[r][c]:
                continue
            flip = False
            if mask == 0:
                flip = (r + c) % 2 == 0
            elif mask == 1:
                flip = r % 2 == 0
            elif mask == 2:
                flip = c % 3 == 0
            elif mask == 3:
                flip = (r + c) % 3 == 0
            elif mask == 4:
                flip = (r // 2 + c // 3) % 2 == 0
            elif mask == 5:
                flip = (r * c) % 2 + (r * c) % 3 == 0
            elif mask == 6:
                flip = ((r * c) % 2 + (r * c) % 3) % 2 == 0
            elif mask == 7:
                flip = ((r + c) % 2 + (r * c) % 3) % 2 == 0
            if flip:
                out[r][c] ^= 1
    return out


def _set_format(m: list[list[int]], mask: int) -> None:
    """ISO/IEC 18004 format information（15 bit）兩處副本。"""
    size = len(m)
    bits = _format_bits(mask)
    # 副本 1：繞左上 finder（bit14 → bit0）
    # row 8, cols 0-5,7,8；再 col 8, rows 7,5,4,3,2,1,0
    coords1 = [
        (8, 0), (8, 1), (8, 2), (8, 3), (8, 4), (8, 5), (8, 7), (8, 8),
        (7, 8), (5, 8), (4, 8), (3, 8), (2, 8), (1, 8), (0, 8),
    ]
    for i, (r, c) in enumerate(coords1):
        m[r][c] = (bits >> (14 - i)) & 1
    # 副本 2：右側 row8 + 下方 col8
    # bit0..7 → (8, n-1) .. (8, n-8)；bit8..14 → (n-7, 8) .. (n-1, 8)
    for i in range(8):
        m[8][size - 1 - i] = (bits >> i) & 1
    for i in range(7):
        m[size - 7 + i][8] = (bits >> (8 + i)) & 1


def _penalty(m: list[list[int]]) -> int:
    size = len(m)
    score = 0
    # N1: runs
    for r in range(size):
        run = 1
        for c in range(1, size):
            if m[r][c] == m[r][c - 1]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)
    for c in range(size):
        run = 1
        for r in range(1, size):
            if m[r][c] == m[r - 1][c]:
                run += 1
            else:
                if run >= 5:
                    score += 3 + (run - 5)
                run = 1
        if run >= 5:
            score += 3 + (run - 5)
    # N2: 2x2 blocks
    for r in range(size - 1):
        for c in range(size - 1):
            v = m[r][c]
            if v == m[r][c + 1] == m[r + 1][c] == m[r + 1][c + 1]:
                score += 3
    # N3: finder-like
    pat_a = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
    pat_b = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1]
    for r in range(size):
        row = m[r]
        for c in range(size - 10):
            window = row[c : c + 11]
            if window == pat_a or window == pat_b:
                score += 40
    for c in range(size):
        col = [m[r][c] for r in range(size)]
        for r in range(size - 10):
            window = col[r : r + 11]
            if window == pat_a or window == pat_b:
                score += 40
    # N4: balance
    dark = sum(sum(row) for row in m)
    total = size * size
    percent = (dark * 100) // total
    score += abs(percent - 50) // 5 * 10
    return score


def encode_matrix(text: str) -> list[list[int]]:
    data = text.encode("utf-8")
    version = _choose_version(len(data))
    codewords = _encode_data(data, version)
    size = _matrix_size(version)
    reserved_m = _reserve(size, version)
    # mark reserved
    reserved = [[cell is not None for cell in row] for row in reserved_m]
    work: list[list[int | None]] = [row[:] for row in reserved_m]
    _place_data(work, codewords)
    # fill remaining None as 0
    base = [[0 if cell is None else int(cell) for cell in row] for row in work]
    best = None
    best_score = 1 << 30
    for mask in range(8):
        masked = _apply_mask(base, mask, reserved)
        _set_format(masked, mask)
        _set_version_info(masked, version)
        sc = _penalty(masked)
        if sc < best_score:
            best_score = sc
            best = masked
    assert best is not None
    return best


# ⚠️ 顏色在這裡**不是裝飾，是碼本身**（勿加 NO_COLOR 之類的開關）：塊字符用前景色畫暗模組、
# 用背景色畫亮模組，不顯式指定就跟着終端主題走——深色終端上整張碼是**反相**的，而 iOS 端用
# 的 AVCaptureMetadataOutput 讀不了反相 QR，等於這個功能對用深色終端的人根本不存在。
# 舊實現 `qrencode -t ANSIUTF8` 一直是顯式吐白底黑碼的，換成純庫渲染不能把這條丟了。
_ANSI_QR = "\x1b[30;107m"   # 黑前景（暗模組）+ 亮白背景（亮模組）
_ANSI_RESET = "\x1b[0m"


def render_qr_terminal(text: str, quiet: int = 2) -> str | None:
    """返回半高塊字符 QR 字符串（自帶 ANSI 黑白配色）；失敗返回 None。"""
    if not text:
        return None
    try:
        mat = encode_matrix(text)
    except Exception:
        return None
    size = len(mat)
    n = size + quiet * 2

    def at(r: int, c: int) -> bool:
        rr, cc = r - quiet, c - quiet
        if rr < 0 or cc < 0 or rr >= size or cc >= size:
            return False
        return bool(mat[rr][cc])

    lines: list[str] = []
    for r in range(0, n, 2):
        chars: list[str] = []
        for c in range(n):
            top = at(r, c)
            bot = at(r + 1, c) if r + 1 < n else False
            if top and bot:
                chars.append("█")
            elif top:
                chars.append("▀")
            elif bot:
                chars.append("▄")
            else:
                chars.append(" ")
        lines.append(f"{_ANSI_QR}{''.join(chars)}{_ANSI_RESET}")
    return "\n".join(lines)


def print_qr_terminal(text: str, hint: str = "scan with the Macchiato iOS app") -> None:
    qr = render_qr_terminal(text)
    if not qr:
        return
    print("\n" + qr)
    print(f"  ({hint})")

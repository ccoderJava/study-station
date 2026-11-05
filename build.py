#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
复习站构建器
------------
content/ 下的 markdown（带 YAML front-matter）→ 静态站点（index.html + assets/）

用法：
    python3 build.py            # 构建
    python3 build.py --check    # 只校验（front-matter + 正文规范），不生成

零第三方依赖，只用 Python 标准库。
"""
import os
import re
import json
import html
import sys
import datetime

BASE = os.path.dirname(os.path.abspath(__file__))
CONTENT = os.path.join(BASE, "content")
THEME = os.path.join(BASE, "theme")
DIST = BASE
ASSETS = os.path.join(DIST, "assets")

TODAY = datetime.date.today().isoformat()

# 30 秒简述的字数口径：只数汉字，标点、英文字母、数字、代码都不算
BRIEF_MIN, BRIEF_MAX = 150, 250
# 精读笔记的摘要更短：讲清「这篇值不值得看」，不用背
READ_MIN, READ_MAX = 80, 200
HAN_RE = re.compile(r"[\u4e00-\u9fff]")

# 精读笔记的骨架，与卡片的七段式不同：先复述、再判断，判断必须跟原文分开
READ_SECTIONS = ["## 30 秒摘要", "## 它讲了什么", "## 关键论据", "## 我的判断", "## 落到我这里"]

# 模拟面试记录：候选者回答逐字归档，复盘由面试官写，最后一段永远留给候选者本人
INTERVIEW_MIN, INTERVIEW_MAX = 50, 240
INTERVIEW_SECTIONS = ["## 本场结论", "## 逐题复盘", "## 暴露的缺口",
                      "## 下次要补的", "## 我的口述记录"]


def han_count(text):
    """只统计汉字数，与页面上念出来的字数一致。"""
    return len(HAN_RE.findall(text))


def brief_section(body, title="## 30 秒简述"):
    """取出正文里指定标题的整段；没有该段返回 None。

    只认行首的二级标题，代码块里的 `## ` 不算标题。
    """
    out, inside, fenced = [], False, False
    for ln in body.split("\n"):
        if ln.strip().startswith("```"):
            fenced = not fenced
            if inside:
                out.append(ln)
            continue
        if not fenced and re.match(r"^##\s+", ln):
            if inside:
                break
            if ln.strip() == title:
                inside = True
            continue
        if inside:
            out.append(ln)
    return "\n".join(out) if inside else None


def sections_of(body):
    """正文里所有二级标题的字面，用来校验骨架齐不齐。"""
    return [ln.strip() for ln in body.split("\n") if re.match(r"^##\s+", ln.strip())]


# ---------------------------------------------------------------- front-matter

def parse_front_matter(text):
    """解析 --- 包裹的 YAML 子集：key: value / key: "value" / key: [a, b]"""
    text = text.replace("\r\n", "\n")
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    block = text[3:end].strip("\n")
    body = text[end + 4:].lstrip("\n")
    meta = {}
    for line in block.split("\n"):
        if not line.strip() or line.strip().startswith("#"):
            continue
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if val.startswith("[") and val.endswith("]"):
            inner = val[1:-1].strip()
            meta[key] = [x.strip().strip('"').strip("'") for x in inner.split(",") if x.strip()]
        else:
            if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
                val = val[1:-1]
            meta[key] = val
    return meta, body


# --------------------------------------------------------------- 代码高亮
# 构建期就把 token 切好，页面只负责上色：运行时不跑高亮库，零依赖、离线可用、
# 复制出来仍是原文（span 不影响 textContent）。

_ESC_MAP = str.maketrans({"&": "&amp;", "<": "&lt;", ">": "&gt;"})
_ID_RE = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")
_NUM_RE = re.compile(
    r"0[xX][0-9a-fA-F_]+[lL]?|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?[lLfFdD]?"
)

JAVA_KW = set(
    """abstract assert boolean break byte case catch char class const continue default do double else enum
    extends final finally float for goto if implements import instanceof int interface long native new package
    private protected public return short static strictfp super switch synchronized this throw throws transient
    try var void volatile while record sealed permits yield""".split()
)

SQL_KW = set(
    """select from where group by order having limit offset insert into values update set delete create table alter
    add drop truncate index unique join left right inner outer full cross on as and or not null is in exists between
    like distinct union all case when then else end count sum avg min max coalesce ifnull isnull primary key foreign
    references default asc desc begin commit rollback transaction explain partition over window row_number rank""".split()
)

SHELL_KW = set(
    """if then else elif fi for while until do done case esac function in return export local read echo printf exit
    source set unset shift test""".split()
)

CODE_LANGS = {
    # kw=关键字  lit=字面量  lc=行注释  bc=块注释  q=字符串引号  ci=大小写不敏感
    # key=把 `xxx:` 的 xxx 当键名  annot=识别 @注解  constant=把全大写标识符当常量
    "java": dict(kw=JAVA_KW, lit={"true", "false", "null"}, lc="//", bc=("/*", "*/"),
                 q="\"'", annot=True, constant=True),
    "sql": dict(kw=SQL_KW, lit={"true", "false", "null"}, lc="--", bc=("/*", "*/"),
                q="'\"`", ci=True),
    "json": dict(kw=set(), lit={"true", "false", "null"}, q="\"", key=True),
    "yaml": dict(kw={"true", "false", "null", "yes", "no", "on", "off"}, lc="#",
                 q="\"'", key=True),
    "bash": dict(kw=SHELL_KW, lc="#", q="\"'"),
    "lua": dict(kw=set("""local function if then else elseif end for while do return break repeat until in
        nil true false and or not""".split()), lit={"nil", "true", "false"},
               lc="--", bc=("--[[", "]]"), q="\"'"),
    "sh": dict(kw=SHELL_KW, lc="#", q="\"'"),
    "shell": dict(kw=SHELL_KW, lc="#", q="\"'"),
    "properties": dict(kw=set(), lc="#", q="\"'", key=True),
}


def _tok(cls, text):
    return '<span class="t-%s">%s</span>' % (cls, text.translate(_ESC_MAP))


def highlight(code, lang):
    """把源码切成带 class 的 span。语言不认识就原样转义，绝不吞内容。"""
    spec = CODE_LANGS.get((lang or "").lower().strip())
    if not spec:
        return code.translate(_ESC_MAP)

    kw, lit = spec.get("kw") or set(), spec.get("lit") or set()
    lc, bc = spec.get("lc"), spec.get("bc")
    quotes, ci = spec.get("q") or "\"'", spec.get("ci")
    annot, key_style = spec.get("annot"), spec.get("key")
    constant = spec.get("constant")

    out, i, n = [], 0, len(code)

    def key_ahead(j):
        """跳过空白后是不是 ':'（JSON / YAML 的键名判断）。"""
        k = j
        while k < n and code[k] in " \t":
            k += 1
        return key_style and k < n and code[k] == ":"

    while i < n:
        c = code[i]

        if bc and code.startswith(bc[0], i):
            j = code.find(bc[1], i + len(bc[0]))
            j = n if j < 0 else j + len(bc[1])
            out.append(_tok("cm", code[i:j]))
            i = j
            continue

        if lc and code.startswith(lc, i):
            j = code.find("\n", i)
            j = n if j < 0 else j
            out.append(_tok("cm", code[i:j]))
            i = j
            continue

        if annot and c == "@":
            m = _ID_RE.match(code, i + 1)
            if m:
                out.append(_tok("an", code[i:m.end()]))
                i = m.end()
                continue

        if c in quotes:
            j = i + 1
            while j < n:
                if code[j] == "\\":
                    j += 2
                    continue
                if code[j] == c:
                    j += 1
                    break
                if code[j] == "\n":      # 未闭合：到行尾就停，别把后面的代码全吞了
                    break
                j += 1
            j = min(j, n)
            out.append(_tok("key" if key_ahead(j) else "str", code[i:j]))
            i = j
            continue

        if c.isdigit():
            m = _NUM_RE.match(code, i)
            if m and m.end() > i:
                out.append(_tok("num", m.group(0)))
                i = m.end()
                continue

        m = _ID_RE.match(code, i)
        if m:
            w, j = m.group(0), m.end()
            probe = w.lower() if ci else w
            if probe in kw:
                cls = "kw"
            elif probe in lit:
                cls = "lit"
            elif constant and len(w) > 1 and w.isupper():
                cls = "const"
            elif j < n and code[j] == "(":
                cls = "fn"
            elif c.isupper():
                cls = "ty"
            elif key_style and code[j:j + 1] == ":":
                cls = "key"
            else:
                cls = None
            out.append(_tok(cls, w) if cls else w.translate(_ESC_MAP))
            i = j
            continue

        out.append(c.translate(_ESC_MAP))
        i += 1

    return "".join(out)


# ------------------------------------------------------------------- markdown

# 正文里 `E5-01 支付状态机与超时补偿` 这种「回看」写法，自动变成站内卡片链接。
# 规则收得很窄：反引号内必须以「节点号-序号 + 空格 + 标题」开头，单独一个 id 或普通代码片段都不转。
CARD_REF_RE = re.compile(r"^([A-Z]\d-\d\d)\s+(.+)$")


def inline(s):
    s = html.escape(s, quote=False)

    def code_or_ref(m):
        txt = m.group(1)
        ref = CARD_REF_RE.match(txt)
        if ref:
            return '<a class="cardref" href="#/card/%s">%s</a>' % (ref.group(1), txt)
        return "<code>%s</code>" % txt

    s = re.sub(r"`([^`]+)`", code_or_ref, s)
    # 加粗用非贪婪匹配：允许 **…`len * 2 / 3`…** 这种正文里带单个 * 的写法
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"<em>\1</em>", s)
    s = re.sub(r"!\[([^\]]*)\]\(([^)\s]+)\)", r'<img src="\2" alt="\1" loading="lazy">', s)
    s = re.sub(r"(?<!!)\[([^\]]+)\]\((https?://[^)]+)\)", r'<a href="\2" target="_blank" rel="noopener">\1</a>', s)
    return s


def inline_svg(src):
    """把本地 svg 原样内联，返回 svg 源码；不是 svg 或找不到则返回空串。

    file:// 下 <img src="...svg"> 会被 Chrome 的源限制拦住（naturalWidth=0），
    内联是唯一在离线场景稳定显示的办法。
    """
    if not src.lower().endswith(".svg"):
        return ""
    name = os.path.basename(src)
    for p in (os.path.join(THEME, "img", name), os.path.join(BASE, src)):
        if os.path.exists(p):
            s = open(p, encoding="utf-8").read()
            s = re.sub(r"<\?xml[^>]*\?>", "", s).strip()
            return re.sub(r"<svg\s", '<svg class="figsvg" ', s, count=1)
    return ""


def is_item_continuation(raw):
    """这一行是不是上一个列表项的续行（缩进了，但不是新的块）。"""
    if not raw.strip() or not re.match(r"^\s{2,}", raw):
        return False
    t = raw.strip()
    if re.match(r"^([-*+]|\d+[.)])\s", t):        # 嵌套列表
        return False
    if t.startswith(("```", "|", ">", "#")):       # 代码 / 表格 / 引用 / 标题
        return False
    if re.match(r"^(-{3,}|\*{3,}|_{3,})$", t):     # 分隔线
        return False
    return True


def render_items(items):
    """items: [(indent, marker, text)] → 支持嵌套的 ul/ol

    有序列表会带上 start：列表项之间夹了空行时会被切成多个 <ol>，
    不带 start 每条都会从 1 开始编号。
    text 里的换行是「条目续行」，渲染成 <br/>，不另起段落。
    """
    res, stack = [], []
    for ind, marker, text in items:
        num = re.match(r"^(\d+)", marker)
        tag = "ol" if num else "ul"
        open_tag = '<ol start="%s">' % num.group(1) if num else "<ul>"
        while stack and ind < stack[-1][0]:
            res.append("</%s>" % stack.pop()[1])
        if not stack or ind > stack[-1][0]:
            res.append(open_tag)
            stack.append((ind, tag))
        elif stack[-1][1] != tag:
            res.append("</%s>%s" % (stack.pop()[1], open_tag))
            stack.append((ind, tag))
        body = "<br/>".join(inline(x) for x in text.split("\n"))
        res.append("<li>%s</li>" % body)
    while stack:
        res.append("</%s>" % stack.pop()[1])
    return "".join(res)


def render_table(rows):
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    sep = None
    if len(cells) >= 2 and all(re.match(r"^:?-{1,}:?$", c.replace(" ", "")) for c in cells[1]):
        sep = cells[1]
        body = [cells[0]] + cells[2:]
    else:
        body = cells
    aligns = []
    if sep:
        for c in sep:
            c = c.replace(" ", "")
            if c.startswith(":") and c.endswith(":"):
                aligns.append("center")
            elif c.endswith(":"):
                aligns.append("right")
            else:
                aligns.append("left")
    out = ["<div class='tw'><table>"]
    for ri, row in enumerate(body):
        tag = "th" if ri == 0 and sep else "td"
        tds = []
        for ci, c in enumerate(row):
            al = aligns[ci] if ci < len(aligns) else "left"
            style = " style='text-align:%s'" % al if al != "left" else ""
            tds.append("<%s%s>%s</%s>" % (tag, style, inline(c), tag))
        out.append("<tr>" + "".join(tds) + "</tr>")
    out.append("</table></div>")
    return "".join(out)


def md_to_html(md, hid_prefix=None):
    """返回 (html, toc)。hid_prefix 非空时给标题加 id，并收集目录项。"""
    lines = md.replace("\r\n", "\n").split("\n")
    out, i, n = [], 0, len(lines)
    toc = []
    while i < n:
        line = lines[i]
        s = line.strip()
        if not s:
            i += 1
            continue

        if s.startswith("```"):
            lang = s[3:].strip()
            i += 1
            buf = []
            while i < n and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            attr = ' data-lang="%s"' % html.escape(lang) if lang else ""
            out.append('<div class="cb"%s><pre><code>%s</code></pre></div>'
                       % (attr, highlight("\n".join(buf), lang)))
            continue

        m = re.match(r"^(#{1,6})\s+(.*)$", s)
        if m:
            lvl = len(m.group(1))
            raw = m.group(2)
            hid = ""
            if hid_prefix:
                hid = ' id="%s%d"' % (hid_prefix, len(toc) + 1)
                plain = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", raw)
                plain = re.sub(r"[*`]", "", plain).strip()
                toc.append({"id": "%s%d" % (hid_prefix, len(toc) + 1), "t": plain, "lv": lvl})
            out.append("<h%d%s>%s</h%d>" % (lvl, hid, inline(raw), lvl))
            i += 1
            continue

        if re.match(r"^(-{3,}|\*{3,}|_{3,})$", s):
            out.append("<hr/>")
            i += 1
            continue

        if s.startswith("|"):
            rows = []
            while i < n and lines[i].strip().startswith("|"):
                rows.append(lines[i].strip())
                i += 1
            out.append(render_table(rows))
            continue

        if s.startswith(">"):
            buf = []
            while i < n and lines[i].strip().startswith(">"):
                buf.append(inline(lines[i].strip()[1:].strip()))
                i += 1
            out.append("<blockquote>" + "<br/>".join(buf) + "</blockquote>")
            continue

        if re.match(r"^\s*([-*+]|\d+[.)])\s+", line):
            items = []
            while i < n:
                mm = re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)$", lines[i])
                if mm:
                    items.append([len(mm.group(1)), mm.group(2), mm.group(3)])
                    i += 1
                    continue
                # 紧跟的缩进续行并进上一项：中文技术文里「条目 + 说明」是最常见的写法，
                # 不合并的话说明会掉成独立段落，和条目脱开。
                if items and is_item_continuation(lines[i]):
                    items[-1][2] += "\n" + lines[i].strip()
                    i += 1
                    continue
                break
            out.append(render_items(items))
            continue

        buf = []
        while i < n:
            cs = lines[i].strip()
            if not cs:
                break
            if re.match(r"^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```)", cs):
                break
            if re.match(r"^(-{3,}|\*{3,}|_{3,})$", cs):
                break
            buf.append(cs)
            i += 1
        if buf:
            # 整段只有一个图片 → 出 figure，alt 当图注
            if len(buf) == 1:
                mi = re.fullmatch(r"!\[([^\]]*)\]\(([^)\s]+)\)", buf[0])
                if mi:
                    alt, src = mi.group(1), mi.group(2)
                    cap = '<figcaption>%s</figcaption>' % html.escape(alt) if alt else ""
                    svg = inline_svg(src)
                    if svg:
                        out.append('<figure class="fig">%s%s</figure>' % (svg, cap))
                    else:
                        out.append('<figure><img src="%s" alt="%s" loading="lazy">%s</figure>'
                                   % (src, html.escape(alt), cap))
                    continue
            text = ""
            for k, raw in enumerate(buf):
                if k and re.search(r"[A-Za-z0-9]$", buf[k - 1]) and re.match(r"^[A-Za-z0-9]", raw):
                    text += " "
                text += inline(raw)
            out.append("<p>" + text + "</p>")
    return "\n".join(out), toc


def excerpt(md, limit=72):
    for ln in md.split("\n"):
        s = ln.strip()
        if not s or s.startswith("#") or s.startswith(">") or s.startswith("|") or s.startswith("---"):
            continue
        s = re.sub(r"[*`>]", "", s)
        s = re.sub(r"^\s*[-*+]\s+", "", s)
        return s[:limit] + ("…" if len(s) > limit else "")
    return ""


# ------------------------------------------------------------------- 语气检查
# 规范在 FORMAT.md 5.1：像跟同事讲，不像交报告。
# 光写文档没用，得让构建器说话：存量欠账记在 tone-baseline.json，只卡新增；
# 改顺一篇就 `--tone-baseline` 收紧一次，基线只准降。

TONE_RULES = [
    # (规则名, 正则, 每篇允许次数)
    ("总结腔",   r"总而言之|综上所述|概而言之|由此可见|一句话(?:结论|总结)", 0),
    ("报幕腔",   r"核心在于|答案很(?:简单|直接)", 0),
    ("强调腔",   r"(?:值得|需要)(?:注意|强调|说明|一提)的是", 0),
    ("空转腔",   r"这恰恰(?:说明|印证)|某种意义上|某种程度上", 0),
    ("递进套话", r"不仅仅是[^。！？\n]{0,40}?更是", 0),
    ("黑话",     r"赋能|抓手|组合拳|颗粒度|护城河|飞轮效应", 0),
    ("三段排比", r"更[^。，、\n]{1,5}、更[^。，、\n]{1,5}、更", 0),
    ("本质是",   r"本质(?:上|就)?是", 1),
    ("首先其次", r"首先|其次", 1),
    ("不是A而是B", r"不是[^。！？\n]{0,30}?，?而是", 1),
    ("句首最后", r"(?:^|[。！？；\n]|，)最后[，、]", 1),
]

TONE_BASELINE = os.path.join(BASE, "tone-baseline.json")


def tone_text(body):
    """取出需要检查语气的正文。

    代码块不算腔调（那是代码）；`## 我的口述记录` 之后是用户自己写的，不归 agent 管；
    引用块是候选者的原话或原文摘引，也不能按我的口癖去卡。
    """
    text = re.sub(r"```.*?```", "", body, flags=re.S)
    cut = text.find("## 我的口述记录")
    if cut >= 0:
        text = text[:cut]
    return "\n".join(ln for ln in text.split("\n") if not ln.lstrip().startswith(">"))


def tone_scan(body):
    """返回 {规则名: {"n": 次数, "hit": 第一处命中的片段}}。"""
    text = tone_text(body)
    hits = {}
    for name, pat, _ in TONE_RULES:
        found = list(re.finditer(pat, text))
        if found:
            at = found[0].start()
            hits[name] = {"n": len(found),
                          "hit": text[max(0, at - 12):at + 18].replace("\n", " ")}
    return hits


def load_tone_baseline():
    if not os.path.exists(TONE_BASELINE):
        return {}
    try:
        return json.load(open(TONE_BASELINE, encoding="utf-8")).get("files", {})
    except (ValueError, OSError):
        return {}


def save_tone_baseline(files_counts):
    """files_counts: {相对路径: {规则名: 次数}}，只写非零项。"""
    out = {"note": "语气检查的存量欠账。生成的，别手改；改顺手了就 python3 build.py --tone-baseline 收紧。",
           "files": {k: v for k, v in sorted(files_counts.items()) if v}}
    open(TONE_BASELINE, "w", encoding="utf-8").write(
        json.dumps(out, ensure_ascii=False, indent=1, sort_keys=True) + "\n")


def tone_report(items, baseline, problems):
    """把超基线的命中写进 problems，返回（欠账篇数, 欠账处数）。

    允许量 = max(该规则阈值, 基线)。基线是历史欠账的豁免，不是新内容的额度。
    """
    limits = {name: lim for name, _, lim in TONE_RULES}
    debt_files = debt_hits = 0
    for C in items:
        path = C["_file"]
        hits = tone_scan(C["_body"])
        if hits:
            debt_files += 1
            debt_hits += sum(v["n"] for v in hits.values())
        base = baseline.get(path, {})
        for name, v in hits.items():
            allowed = max(limits.get(name, 0), base.get(name, 0))
            if v["n"] > allowed:
                problems.append(
                    "语气超基线：%s 有 %d 处「%s」（上限 %d，如「%s」）"
                    % (path, v["n"], name, allowed, v["hit"]))
    return debt_files, debt_hits


# ------------------------------------------------------------------- 加载内容

def load_dir(sub):
    d = os.path.join(CONTENT, sub)
    if not os.path.isdir(d):
        return []
    result = []
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".md"):
            continue
        raw = open(os.path.join(d, fn), encoding="utf-8").read()
        meta, body = parse_front_matter(raw)
        meta["_file"] = "%s/%s" % (sub, fn)
        meta["_body"] = body
        result.append(meta)
    return result


def build_data():
    layers = load_dir("layers")
    nodes = load_dir("nodes")
    cards = load_dir("cards")
    scenarios = load_dir("scenarios")
    reads = load_dir("reads")
    interviews = load_dir("interviews")

    layers.sort(key=lambda x: int(x.get("order", 99)))
    nodes.sort(key=lambda x: x.get("id", ""))
    items = cards + scenarios + reads + interviews

    problems = []

    def need(obj, keys, label):
        for k in keys:
            if not obj.get(k):
                problems.append("%s 缺少字段 %s" % (label, k))

    for L in layers:
        need(L, ["id", "name"], "layer:%s" % L["_file"])
    for N in nodes:
        need(N, ["id", "layer", "name"], "node:%s" % N["_file"])
    for C in items:
        need(C, ["id", "title", "kind"], "item:%s" % C["_file"])
        if isinstance(C["nodes"], str):
            C["nodes"] = [x.strip() for x in C["nodes"].split(",") if x.strip()]
        if not isinstance(C["nodes"], list):
            C["nodes"] = []
        if C["_file"].startswith("reads/"):
            # 精读笔记：必须有原文链接；节点可以先不挂，读完再归类
            if C.get("kind") != "read":
                problems.append("精读笔记的 kind 必须是 read: %s" % C["_file"])
            need(C, ["source"], "read:%s" % C["_file"])
            if C.get("source") and not str(C["source"]).startswith(("http://", "https://")):
                problems.append("精读笔记的 source 必须是 http(s) 链接: %s" % C["_file"])
        elif C["_file"].startswith("interviews/"):
            # 面试记录：gaps 是查漏补缺聚合的数据源，必须是知识点 id
            if C.get("kind") != "interview":
                problems.append("面试记录的 kind 必须是 interview: %s" % C["_file"])
            need(C, ["date"], "interview:%s" % C["_file"])
            if isinstance(C.get("gaps"), str):
                C["gaps"] = [x.strip() for x in C["gaps"].split(",") if x.strip()]
            if not isinstance(C.get("gaps"), list):
                C["gaps"] = []
        elif not C["nodes"]:
            problems.append("item:%s 缺少字段 nodes" % C["_file"])

    node_ids = {n["id"] for n in nodes}
    layer_ids = {l["id"] for l in layers}
    for N in nodes:
        if N["layer"] not in layer_ids:
            problems.append("node %s 的 layer %s 不存在" % (N["id"], N["layer"]))
    for C in items:
        for t in C["nodes"]:
            if t not in node_ids:
                problems.append("item %s 引用了不存在的知识点 %s" % (C["id"], t))
        for t in C.get("gaps", []):
            if t not in node_ids:
                problems.append("item %s 的 gaps 里有不存在的知识点 %s" % (C["id"], t))

    # 30 秒简述是复述骨架：字数不达标就没法背，直接算校验失败
    for C in items:
        if C.get("kind") == "interview":
            sec = brief_section(C["_body"], "## 本场结论")
            if sec is None:
                problems.append("面试记录缺段：%s 没有「## 本场结论」" % C["_file"])
            else:
                n = han_count(sec)
                if not INTERVIEW_MIN <= n <= INTERVIEW_MAX:
                    problems.append("本场结论不达标：%s 实际 %d 个汉字（要求 %d~%d）"
                                    % (C["_file"], n, INTERVIEW_MIN, INTERVIEW_MAX))
            have = sections_of(C["_body"])
            miss = [s for s in INTERVIEW_SECTIONS if s not in have]
            if miss:
                problems.append("面试骨架缺段：%s 少了 %s" % (C["_file"], "、".join(miss)))
            qsec = brief_section(C["_body"], "## 逐题复盘") or ""
            C["_qcount"] = len(re.findall(r"^### Q\d+", qsec, re.M))
            if not C["_qcount"]:
                problems.append("逐题复盘没有题目：%s 里至少要有一个「### Q1 ...」" % C["_file"])
            continue
        if C.get("kind") == "read":
            sec = brief_section(C["_body"], "## 30 秒摘要")
            if sec is None:
                problems.append("30 秒摘要缺失：%s 没有「## 30 秒摘要」段" % C["_file"])
            else:
                n = han_count(sec)
                C["_brief"] = n
                if n < READ_MIN:
                    problems.append("30 秒摘要不达标：%s 实际 %d 个汉字（要求 %d~%d，偏短 %d）"
                                    % (C["_file"], n, READ_MIN, READ_MAX, READ_MIN - n))
                elif n > READ_MAX:
                    problems.append("30 秒摘要不达标：%s 实际 %d 个汉字（要求 %d~%d，偏长 %d）"
                                    % (C["_file"], n, READ_MIN, READ_MAX, n - READ_MAX))
            have = sections_of(C["_body"])
            miss = [s for s in READ_SECTIONS if s not in have]
            if miss:
                problems.append("精读骨架缺段：%s 少了 %s" % (C["_file"], "、".join(miss)))
            continue
        sec = brief_section(C["_body"])
        if sec is None:
            problems.append("30 秒简述缺失：%s 没有「## 30 秒简述」段" % C["_file"])
            continue
        n = han_count(sec)
        C["_brief"] = n
        if n < BRIEF_MIN:
            problems.append("30 秒简述不达标：%s 实际 %d 个汉字（要求 %d~%d，偏短 %d）"
                            % (C["_file"], n, BRIEF_MIN, BRIEF_MAX, BRIEF_MIN - n))
        elif n > BRIEF_MAX:
            problems.append("30 秒简述不达标：%s 实际 %d 个汉字（要求 %d~%d，偏长 %d）"
                            % (C["_file"], n, BRIEF_MIN, BRIEF_MAX, n - BRIEF_MAX))

    ids = [c["id"] for c in items]
    dup = {x for x in ids if ids.count(x) > 1}
    if dup:
        problems.append("重复的 id: %s" % ", ".join(sorted(dup)))

    for C in items:
        C["_html"], C["_toc"] = md_to_html(C["_body"], "s")
        C["_excerpt"] = excerpt(C["_body"])
        C["level"] = C.get("level", "normal")
        C["status"] = C.get("status", "draft")
    for N in nodes:
        N["_html"], _ = md_to_html(N["_body"])
        N["_excerpt"] = excerpt(N["_body"])

    for N in nodes:
        N["cards"] = [c["id"] for c in cards if N["id"] in c["nodes"]]
        N["scenarios"] = [c["id"] for c in scenarios if N["id"] in c["nodes"]]
        N["reads"] = [c["id"] for c in reads if N["id"] in c["nodes"]]
        # 面试里被标成薄弱点的节点，即使题目没挂它，也算相关面试
        N["interviews"] = [c["id"] for c in interviews
                           if N["id"] in c["nodes"] or N["id"] in c.get("gaps", [])]

    # 插图必须真实存在：md 里写了 ![图注](img/x.svg) 但文件不在，页面会静默少一张图
    for obj in items + nodes:
        for m in re.finditer(r"!\[[^\]]*\]\(([^)\s]+)\)", obj["_body"]):
            src = m.group(1)
            if src.startswith(("http://", "https://")):
                problems.append("%s 引用了外链插图（内网打不开）: %s" % (obj["id"], src))
                continue
            if not (os.path.exists(os.path.join(THEME, "img", os.path.basename(src)))
                    or os.path.exists(os.path.join(BASE, src))):
                problems.append("%s 引用的插图不存在: %s" % (obj["id"], src))

    # 回看链接：反引号里的卡片 id 必须真实存在，点过去不能是空白页。
    # 代码块不扫（``` 里的反引号是语法）；渲染侧用同一条 CARD_REF_RE，保证校验和显示一致。
    item_ids = {c["id"] for c in items}
    for obj in items + nodes:
        body = re.sub(r"```.*?```", "", obj["_body"], flags=re.S)
        for m in re.finditer(r"`([^`\n]+)`", body):
            ref = CARD_REF_RE.match(m.group(1))
            if ref and ref.group(1) not in item_ids:
                problems.append("%s 回看的卡片不存在: %s" % (obj["id"], ref.group(1)))

    # 语气：存量记基线，只有超配额的新句子才算错
    tone_files, tone_hits = tone_report(items, load_tone_baseline(), problems)

    data = {
        "generated": TODAY,
        "layers": [{"id": l["id"], "name": l["name"], "role": l.get("role", ""),
                    "desc": l.get("desc", ""), "order": int(l.get("order", 99))} for l in layers],
        "nodes": [{"id": n["id"], "layer": n["layer"], "name": n["name"],
                   "keywords": n.get("keywords", []), "html": n["_html"],
                   "excerpt": n["_excerpt"], "cards": n["cards"],
                   "scenarios": n["scenarios"], "reads": n["reads"],
                   "interviews": n["interviews"]} for n in nodes],
        "items": [{"id": c["id"], "kind": c["kind"], "title": c["title"],
                   "graph": c.get("graph", ""),
                   "nodes": c["nodes"], "primary": c.get("primary", c["nodes"][0] if c["nodes"] else ""),
                   "direction": c.get("direction", "未分类"), "event": c.get("event", "未分类"),
                   "project": c.get("project", ""), "level": c["level"],
                   "status": c["status"], "created": c.get("created", ""),
                   "updated": c.get("updated", ""), "html": c["_html"],
                   "src": ({"url": c.get("source", ""), "site": c.get("source_site", ""),
                            "author": c.get("author", ""), "date": c.get("published", ""),
                            "read": c.get("read_on", "")} if c.get("kind") == "read" else None),
                   "itv": ({"date": c.get("date", ""), "score": c.get("score", ""),
                            "gaps": c.get("gaps", []), "qcount": c.get("_qcount", 0),
                            "duration": c.get("duration", ""),
                            "focus": c.get("focus", "")} if c.get("kind") == "interview" else None),
                   "toc": c["_toc"], "excerpt": c["_excerpt"]} for c in items],
    }
    return data, problems, (tone_files, tone_hits)


# ------------------------------------------------------------------- 生成站点

def write_site(data):
    os.makedirs(ASSETS, exist_ok=True)
    tpl_index = open(os.path.join(THEME, "index.html"), encoding="utf-8").read()
    open(os.path.join(DIST, "index.html"), "w", encoding="utf-8").write(tpl_index)

    for name in ("app.js", "style.css"):
        src = os.path.join(THEME, name)
        if os.path.exists(src):
            open(os.path.join(ASSETS, name), "w", encoding="utf-8").write(
                open(src, encoding="utf-8").read())

    # 主题内的插图（SVG 等）原样拷进 assets/img
    img_src = os.path.join(THEME, "img")
    if os.path.isdir(img_src):
        img_dst = os.path.join(ASSETS, "img")
        os.makedirs(img_dst, exist_ok=True)
        for name in sorted(os.listdir(img_src)):
            p = os.path.join(img_src, name)
            if os.path.isfile(p):
                open(os.path.join(img_dst, name), "wb").write(open(p, "rb").read())

    payload = "window.KB=" + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";"
    open(os.path.join(ASSETS, "data.js"), "w", encoding="utf-8").write(payload)
    return len(payload)


def tone_limits():
    return {name: lim for name, _, lim in TONE_RULES}


def tone_rows(items):
    """逐条列出语气命中：(规则名, 文件, 次数, 片段)，供 --tone 查看。"""
    rows = []
    for C in items:
        for name, v in tone_scan(C["_body"]).items():
            rows.append((name, C["_file"], v["n"], v["hit"]))
    return rows


def main():
    data, problems, (tone_files, tone_hits) = build_data()
    n_brief = len([p for p in problems if p.startswith("30 秒简述")])
    n_tone = len([p for p in problems if p.startswith("语气超基线")])

    # 收紧 / 重建语气基线
    if "--tone-baseline" in sys.argv:
        items = load_dir("cards") + load_dir("scenarios")
        counts = {C["_file"]: {k: v["n"] for k, v in tone_scan(C["_body"]).items()}
                  for C in items}
        save_tone_baseline(counts)
        print("语气基线已更新：欠账 %d 篇 / %d 处" % (tone_files, tone_hits))
        if tone_hits:
            print("  改完的篇目已从基线里去掉，剩下的下次接着改（--tone 看清单）")
        return 0

    # 只看语气
    if "--tone" in sys.argv:
        items = load_dir("cards") + load_dir("scenarios")
        rows = tone_rows(items)
        if not rows:
            print("语气干净：没有命中任何规则（FORMAT.md 5.1）")
            return 0
        limits = tone_limits()
        per = {}
        for name, _f, n, _h in rows:
            per[name] = per.get(name, 0) + n
        print("语气欠账：%d 篇 / %d 处（基线内的存量，改顺手就清，别新增）"
              % (len({f for _n, f, _c, _h in rows}), sum(per.values())))
        for name, n in sorted(per.items(), key=lambda x: -x[1]):
            print("\n[%s] %d 处，每篇上限 %d" % (name, n, limits.get(name, 0)))
            for nm, f, c, h in rows:
                if nm == name:
                    print("   %-46s ×%d  …%s…" % (f, c, h))
        return 0

    if "--check" in sys.argv:
        if problems:
            print("⚠ 内容校验发现 %d 个问题：" % len(problems))
            for p in problems:
                print("   -", p)
            if n_brief:
                print("\n其中 30 秒简述不在 %d~%d 汉字区间的 %d 篇（上方逐条列了文件名和字数）。"
                      % (BRIEF_MIN, BRIEF_MAX, n_brief))
            if n_tone:
                print("\n其中 %d 条是语气超配额（规范在 FORMAT.md 5.1）。\n"
                      "改法：那几个词删掉，用具体的事重写这句；确实不该改就跑 "
                      "`python3 build.py --tone-baseline` 显式放宽（diff 里看得见）。" % n_tone)
            return 1
        print("校验通过：%d 个层 / %d 个知识点 / %d 篇内容（30 秒简述均 %d~%d 汉字）" % (
            len(data["layers"]), len(data["nodes"]), len(data["items"]),
            BRIEF_MIN, BRIEF_MAX))
        print("  语气：未新增命中；存量欠账 %d 篇 / %d 处（python3 build.py --tone 看清单）"
              % (tone_files, tone_hits))
        return 0

    if problems:
        print("⚠ 内容校验发现 %d 个问题：" % len(problems))
        for p in problems:
            print("   -", p)
        if n_brief:
            print("\n其中 30 秒简述不在 %d~%d 汉字区间的 %d 篇。" % (BRIEF_MIN, BRIEF_MAX, n_brief))

    size = write_site(data)
    n_nodes = len(data["nodes"])
    cov = len([n for n in data["nodes"] if n["cards"] or n["scenarios"]])
    n_cards = len([c for c in data["items"] if c["kind"] == "card"])
    n_sc = len([c for c in data["items"] if c["kind"] == "scenario"])
    n_read = len([c for c in data["items"] if c["kind"] == "read"])
    n_itv = len([c for c in data["items"] if c["kind"] == "interview"])
    print("构建完成")
    print("  知识点 %d 个（已覆盖 %d，%.0f%%）" % (n_nodes, cov, cov * 100.0 / max(n_nodes, 1)))
    print("  卡片 %d 篇，场景题 %d 道，精读 %d 篇，模拟面试 %d 场"
          % (n_cards, n_sc, n_read, n_itv))
    print("  数据 %.0f KB → assets/data.js" % (size / 1024.0))
    print("  入口 %s" % os.path.join(DIST, "index.html"))
    return 0


if __name__ == "__main__":
    sys.exit(main())

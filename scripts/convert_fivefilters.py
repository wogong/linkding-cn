#!/usr/bin/env python3
"""
Convert fivefilters/ftr-site-config .txt files to linkding site adapter JSONC format.

Usage:
    python scripts/convert_fivefilters.py /path/to/ftr-site-config output_dir
"""

import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path


# ---------------------------------------------------------------------------
# XPath → CSS conversion
# ---------------------------------------------------------------------------

def xpath_to_css(xpath: str) -> str | None:
    """Convert simple XPath to CSS selector. Returns None if unconvertible."""
    xpath = xpath.strip()
    if not xpath:
        return None

    # Truly unconvertible patterns
    skip_patterns = [
        'substring-before', 'substring-after',
        'text()=', '.=', 'preceding::',
        'following-sibling::', 'preceding-sibling::',
        'ancestor::', 'descendant-or-self',
        '[last()', 'position()', 'count(',
        'starts-with(', 'translate(',
        'contains(text()',
    ]
    for p in skip_patterns:
        if p in xpath:
            return None

    # Handle union: split by | (not inside brackets)
    parts = _split_union(xpath)
    if len(parts) > 1:
        css_parts = []
        for part in parts:
            css = _xpath_single_to_css(part.strip())
            if css:
                css_parts.append(css)
        return ', '.join(css_parts) if css_parts else None
    return _xpath_single_to_css(xpath)


def _split_union(xpath: str) -> list[str]:
    """Split XPath by | respecting brackets and quotes."""
    parts = []
    current = []
    depth = 0
    in_quote = ''
    for ch in xpath:
        if in_quote:
            current.append(ch)
            if ch == in_quote:
                in_quote = ''
            continue
        if ch in ("'", '"'):
            in_quote = ch
            current.append(ch)
            continue
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == '|' and depth == 0:
            parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append(''.join(current))
    return parts


def _xpath_single_to_css(xpath: str) -> str | None:
    """Convert a single (non-union) XPath expression to CSS."""
    s = xpath.strip()

    # Handle (xpath)[N] — position predicate, just strip it
    s = re.sub(r'^\((.+)\)\[\d+\]$', r'\1', s)

    # Remove leading //
    if s.startswith('//'):
        s = s[2:]
    elif s.startswith('/'):
        s = s[1:]

    # normalize-space wrapping: normalize-space(//tag) → //tag
    nm = re.match(r'^normalize-space\((.+)\)$', s)
    if nm:
        s = nm.group(1)
        if s.startswith('//'):
            s = s[2:]

    # substring-before(//meta[@property='og:title']/@content, ' | ') → meta[property="og:title"]
    m = re.match(r"substring-before\((//[^,]+?)/@\w+\s*,", s)
    if m:
        inner = m.group(1)
        css = _convert_path(inner)
        return css

    # substring-after(//..., '...')
    m = re.match(r"substring-after\((//[^,]+?)/@\w+\s*,", s)
    if m:
        css = _convert_path(m.group(1))
        return css

    # //xpath/@attr — strip the attribute part
    m = re.match(r'^(.+?)/@\w+$', s)
    if m:
        s = m.group(1)
        if s.startswith('//'):
            s = s[2:]

    return _convert_path(s)


def _convert_path(s: str) -> str | None:
    """Convert an XPath path (possibly with predicates) to CSS."""
    if not s:
        return None

    # Remove leading //
    if s.startswith('//'):
        s = s[2:]
    elif s.startswith('/'):
        s = s[1:]

    parts = _split_path(s)
    css_parts = []
    for part in parts:
        css = _convert_step(part)
        if css is None:
            return None
        css_parts.append(css)

    return ' > '.join(css_parts) if len(css_parts) > 1 else (css_parts[0] if css_parts else None)


def _split_path(s: str) -> list[str]:
    """Split XPath path by /, respecting brackets."""
    parts = []
    current = []
    depth = 0
    for ch in s:
        if ch == '[':
            depth += 1
        elif ch == ']':
            depth -= 1
        if ch == '/' and depth == 0:
            if current:
                parts.append(''.join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append(''.join(current))
    return parts


def _convert_step(step: str) -> str | None:
    """Convert a single XPath step to CSS."""
    match = re.match(r'^([a-zA-Z*][a-zA-Z0-9_-]*)(.*)?$', step)
    if not match:
        return None

    tag = match.group(1)
    rest = match.group(2) or ''

    predicates = re.findall(r'\[([^\]]+)\]', rest)
    attrs = []
    for pred in predicates:
        css = _convert_predicate(pred)
        if css is None:
            return None
        attrs.append(css)

    if tag == '*':
        tag = ''

    result = tag
    for attr in attrs:
        result += attr

    return result or '*'


def _convert_predicate(pred: str) -> str | None:
    """Convert an XPath predicate to CSS."""
    pred = pred.strip()

    # @class='value'
    m = re.match(r"""@class\s*=\s*['"](.+?)['"]""", pred)
    if m:
        return '.' + m.group(1).replace(' ', '.')

    # @id='value'
    m = re.match(r"""@id\s*=\s*['"](.+?)['"]""", pred)
    if m:
        return '#' + m.group(1)

    # contains(@class, 'value')
    m = re.match(r"""contains\(\s*@class\s*,\s*['"](.+?)['"]\s*\)""", pred)
    if m:
        return '.' + m.group(1)

    # contains(@id, 'value')
    m = re.match(r"""contains\(\s*@id\s*,\s*['"](.+?)['"]\s*\)""", pred)
    if m:
        return f'[id*="{m.group(1)}"]'

    # contains(concat(' ',normalize-space(@class),' '), ' value ')
    m = re.match(
        r"""contains\(\s*concat\(\s*['"]\s*['"]\s*,\s*normalize-space\(\s*@class\s*\)\s*,\s*['"]\s*['"]\s*\)\s*,\s*['"]\s*(.+?)\s*['"]\s*\)""",
        pred
    )
    if m:
        return '.' + m.group(1).strip()

    # contains(concat(' ',normalize-space(@id),' '), ' value ')
    m = re.match(
        r"""contains\(\s*concat\(\s*['"]\s*['"]\s*,\s*normalize-space\(\s*@id\s*\)\s*,\s*['"]\s*['"]\s*\)\s*,\s*['"]\s*(.+?)\s*['"]\s*\)""",
        pred
    )
    if m:
        return f'[id*="{m.group(1).strip()}"]'

    # @attr='value'
    m = re.match(r"""@([\w-]+)\s*=\s*['"](.+?)['"]""", pred)
    if m:
        return f'[{m.group(1)}="{m.group(2)}"]'

    # contains(@attr, 'value')
    m = re.match(r"""contains\(\s*@([\w-]+)\s*,\s*['"](.+?)['"]\s*\)""", pred)
    if m:
        return f'[{m.group(1)}*="{m.group(2)}"]'

    # @attr (attribute exists)
    m = re.match(r'@([\w-]+)$', pred)
    if m:
        return f'[{m.group(1)}]'

    # Position predicate [N] — just ignore it
    if re.match(r'^\d+$', pred):
        return ''

    # @class!='value'
    m = re.match(r"""@class\s*!=\s*['"](.+?)['"]""", pred)
    if m:
        return f':not(.{m.group(1)})'

    # (@class = 'value') — parenthesized predicate
    m = re.match(r"""\(?@class\s*=\s*['"](.+?)['"]\)?""", pred)
    if m:
        return '.' + m.group(1)

    # @attr = 'value' (with spaces around =)
    m = re.match(r"""@([\w-]+)\s*=\s*['"](.+?)['"]""", pred)
    if m:
        return f'[{m.group(1)}="{m.group(2)}"]'

    # div[contains(@class, '')] — empty class, skip
    if "''" in pred or '""' in pred:
        return ''

    return None


# ---------------------------------------------------------------------------
# fivefilters parser
# ---------------------------------------------------------------------------

def parse_fivefilters_config(text: str) -> dict[str, list[str]]:
    directives = defaultdict(list)
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith(('test_url', 'test_contains', 'test_rul', 'test_content', 'test ')):
            continue

        m = re.match(r'^http_header\(([^)]+)\):\s*(.+)$', line, re.IGNORECASE)
        if m:
            directives['http_header'].append((m.group(1).strip(), m.group(2).strip()))
            continue

        m = re.match(r'^([a-z_]+):\s*(.+)$', line)
        if m:
            directives[m.group(1).strip()].append(m.group(2).strip())

    return dict(directives)


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------

def convert_config(domain: str, directives: dict) -> tuple[dict, list[str]]:
    warnings = []
    config = {}

    # http headers
    http = {}
    for name, value in directives.get('http_header', []):
        header_name = name.strip()
        if header_name.lower() == 'user-agent':
            header_name = 'User-Agent'
        http[header_name] = value
    if http:
        config.setdefault('default', {})['http'] = http

    # title
    titles = []
    for xpath in directives.get('title', []):
        css = xpath_to_css(xpath)
        if css:
            if 'og:title' in xpath:
                css = "meta[property='og:title']"
            titles.append(css)
        else:
            warnings.append(f'title: {xpath}')
    if titles:
        config.setdefault('metadata', {})['select_title'] = titles

    # body → keep_elements
    bodies = []
    for xpath in directives.get('body', []):
        css = xpath_to_css(xpath)
        if css:
            bodies.append(css)
        else:
            warnings.append(f'body: {xpath}')
    if bodies:
        config.setdefault('snapshot', {})['keep_elements'] = bodies

    # strip_id_or_class + strip → remove_elements
    remove = []
    for cls in directives.get('strip_id_or_class', []):
        cls = cls.strip()
        if cls.startswith('#') or cls.startswith('.'):
            remove.append(cls)
        elif cls:
            remove.append('.' + cls)

    for xpath in directives.get('strip', []):
        css = xpath_to_css(xpath)
        if css:
            remove.append(css)
        else:
            warnings.append(f'strip: {xpath}')

    if remove:
        config.setdefault('snapshot', {})['remove_elements'] = remove

    # auth
    requires_login = any(
        v.lower() in ('yes', 'true')
        for v in directives.get('requires_login', [])
    )
    if requires_login:
        config.setdefault('auth', {})['cookie'] = {'type': 'login'}

    return config, warnings


def clean_css_selector(css: str) -> str | None:
    if not css:
        return None
    bad = ['parent', 'text()', 'following-sibling', 'preceding-sibling']
    for p in bad:
        if p in css:
            return None
    css = css.strip()
    if css.endswith('>'):
        return None
    return css


def clean_config(config: dict) -> dict:
    for section in ('metadata', 'snapshot'):
        if section not in config:
            continue
        for key in ('select_title', 'select_description', 'select_image',
                     'keep_elements', 'remove_elements'):
            if key not in config[section]:
                continue
            cleaned = [s for s in config[section][key] if clean_css_selector(s)]
            if cleaned:
                config[section][key] = cleaned
            else:
                del config[section][key]

    http = config.get('default', {}).get('http', {})
    if 'cookie' in http:
        val = http['cookie']
        if 'AAAA' in val or len(val) < 20:
            del http['cookie']

    if http:
        normalized = {}
        for k, v in http.items():
            lk = k.lower()
            if lk == 'user-agent':
                normalized['User-Agent'] = v
            elif lk == 'referer':
                normalized['Referer'] = v
            elif lk == 'cookie':
                normalized['Cookie'] = v
            else:
                normalized[k] = v
        config.setdefault('default', {})['http'] = normalized

    return config


def config_is_empty(config: dict) -> bool:
    if not config:
        return True
    sections = set(config.keys())
    if sections == {'default'} and set(config.get('default', {}).keys()) == {'http'}:
        http = config['default']['http']
        if set(http.keys()) == {'User-Agent'}:
            return True
    return False


def to_jsonc(config: dict) -> str:
    return json.dumps(config, indent=2, ensure_ascii=False)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        print(f"Usage: {sys.argv[0]} /path/to/ftr-site-config output_dir")
        sys.exit(1)

    source_dir = sys.argv[1]
    output_dir = sys.argv[2]
    domains_dir = os.path.join(output_dir, 'domains')
    os.makedirs(domains_dir, exist_ok=True)

    stats = {'total': 0, 'converted': 0, 'skipped_empty': 0, 'warnings': 0}
    warn_types = defaultdict(int)

    for txt_path in sorted(Path(source_dir).glob('*.txt')):
        domain = txt_path.stem
        if domain == 'global':
            continue
        # Use wildcard for bare domains (e.g., nytimes.com -> *.nytimes.com)
        # so www.nytimes.com also matches
        if '.' in domain and not domain.startswith('*.') and not domain.startswith('www.'):
            parts = domain.split('.')
            if len(parts) == 2:
                domain = '*.' + domain
        stats['total'] += 1

        with open(txt_path, encoding='utf-8', errors='replace') as f:
            text = f.read()

        directives = parse_fivefilters_config(text)
        config, warnings = convert_config(domain, directives)
        config = clean_config(config)

        if config_is_empty(config):
            stats['skipped_empty'] += 1
            continue

        stats['converted'] += 1
        stats['warnings'] += len(warnings)
        for w in warnings:
            key = w.split(':')[0].strip()
            warn_types[key] += 1

        with open(os.path.join(domains_dir, f'{domain}.jsonc'), 'w', encoding='utf-8') as f:
            f.write(to_jsonc(config))
            f.write('\n')

    # global.jsonc
    global_config = {
        "*": {
            "http": {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            }
        }
    }
    with open(os.path.join(output_dir, 'global.jsonc'), 'w', encoding='utf-8') as f:
        f.write(to_jsonc(global_config))
        f.write('\n')

    print(f"\nConversion complete:")
    print(f"  Total: {stats['total']}")
    print(f"  Converted: {stats['converted']}")
    print(f"  Skipped (empty): {stats['skipped_empty']}")
    print(f"  Total warnings: {stats['warnings']}")
    if warn_types:
        print(f"\nWarnings by type:")
        for wtype, count in sorted(warn_types.items(), key=lambda x: -x[1]):
            print(f"  {wtype}: {count}")


if __name__ == '__main__':
    main()

import os
import glob
import re

project_dir = os.path.dirname(os.path.abspath(__file__))
dist_dir = os.path.join(project_dir, "dist")
assets_dir = os.path.join(dist_dir, "assets")
output_dir = os.path.join(project_dir, "google-apps-script")

os.makedirs(output_dir, exist_ok=True)

# Find CSS and JS files
css_files = glob.glob(os.path.join(assets_dir, "*.css"))
js_files = glob.glob(os.path.join(assets_dir, "*.js"))

if not css_files or not js_files:
    print("Error: Compiled files not found in dist/assets/")
    exit(1)

css_path = css_files[0]
js_path = js_files[0]
css_name = os.path.basename(css_path)
js_name = os.path.basename(js_path)

# Read compiled contents
with open(os.path.join(dist_dir, "index.html"), "r", encoding="utf-8") as f:
    html_content = f.read()

with open(css_path, "r", encoding="utf-8") as f:
    css_content = f.read()

with open(js_path, "r", encoding="utf-8") as f:
    js_content = f.read()

# -----------------------------------------------------------------------
# CRITICAL FIX: Google Apps Script editor has a bug where it treats '//'
# inside template literals (backticks) as the start of a comment.
# To prevent this, we escape all '/' inside template literals.
# -----------------------------------------------------------------------
def escape_slashes_in_template_literals(match):
    content = match.group(0)
    if '//' in content:
        content_escaped = content.replace('//', '\\/\\/')
        print(f"  Escaped template literal containing '//': {content[:80]}...")
        return content_escaped
    return content

template_literal_pattern = re.compile(r'`(?:[^`\\]|\\.)*`')
js_content = template_literal_pattern.sub(escape_slashes_in_template_literals, js_content)

# -----------------------------------------------------------------------
# CRITICAL FIX: GAS HTML service HTML-encodes '&' inside <style> blocks,
# which corrupts @import URLs (e.g. &family= becomes &amp;family=).
# This breaks the entire CSS block and causes a downstream JS SyntaxError.
#
# Solution: extract @import rules from CSS, convert to <link rel="stylesheet">
# tags (which GAS does NOT sanitize), then inline only the remaining CSS.
# -----------------------------------------------------------------------
import_pattern = re.compile(r'@import\s+"([^"]+)"\s*;?\s*', re.IGNORECASE)
font_link_tags = []
for match in import_pattern.finditer(css_content):
    url = match.group(1)
    font_link_tags.append(f'<link rel="stylesheet" href="{url}" />')
    print(f"  Extracted @import: {url[:90]}...")

# Remove all @import lines from the inlined CSS block
css_content_clean = import_pattern.sub('', css_content).strip()

if not font_link_tags:
    print("  Warning: No @import rules found in CSS.")

# Locate CSS link tag in HTML and replace it with clean inlined CSS
css_href = f'href="/assets/{css_name}"'
css_idx = html_content.find(css_href)
if css_idx != -1:
    start_link = html_content.rfind("<link", 0, css_idx)
    end_link = html_content.find(">", css_idx) + 1
    old_link_tag = html_content[start_link:end_link]
    font_links_html = "\n    ".join(font_link_tags)
    replacement = f"{font_links_html}\n    <style>\n{css_content_clean}\n</style>"
    html_content = html_content.replace(old_link_tag, replacement)
    print(f"  CSS inlined ({len(css_content_clean):,} chars). {len(font_link_tags)} @import(s) moved to <link> tags.")
else:
    print("Warning: CSS link not found in index.html")

# Locate JS script tag in HTML, remove from head, insert at bottom of body
js_src = f'src="/assets/{js_name}"'
js_idx = html_content.find(js_src)
if js_idx != -1:
    start_script = html_content.rfind("<script", 0, js_idx)
    end_script = html_content.find("</script>", js_idx) + 9
    old_script_tag = html_content[start_script:end_script]
    html_content = html_content.replace(old_script_tag, "")
    html_content = html_content.replace("</body>", f"<script>\n{js_content}\n</script>\n</body>")
    print(f"  JS inlined at end of body ({len(js_content):,} chars).")
else:
    print("Warning: JS script tag not found in index.html")

# Insert error listener in <head> for early crash capturing
error_listener_head = """<head>
    <script>
      window.addEventListener('error', function(e) {
        var consoleDiv = document.getElementById('gas-error-console');
        var messagePre = document.getElementById('gas-error-message');
        var details = e.message + '\\nFile: ' + e.filename + '\\nLine: ' + e.lineno + '\\nCol: ' + e.colno + '\\n\\nStack:\\n' + (e.error ? e.error.stack : 'No stack trace');
        if (consoleDiv && messagePre) {
          consoleDiv.style.display = 'block';
          messagePre.textContent = details;
        } else {
          window.addEventListener('DOMContentLoaded', function() {
            var consoleDiv = document.getElementById('gas-error-console');
            var messagePre = document.getElementById('gas-error-message');
            if (consoleDiv && messagePre) {
              consoleDiv.style.display = 'block';
              messagePre.textContent = details;
            }
          });
        }
      });
    </script>"""

html_content = html_content.replace("<head>", error_listener_head)

# Insert error console div at start of body
error_console_body = """<body>
    <div id="gas-error-console" style="display:none; padding:20px; background:#fef2f2; border:2px solid #ef4444; color:#991b1b; font-family:monospace; font-size:12px; margin:20px; border-radius:8px; z-index:999999; position:relative; text-align:left;">
      <h3 style="margin-top:0; color:#b91c1c;">🚨 JavaScript Error Detected:</h3>
      <pre id="gas-error-message" style="white-space:pre-wrap;"></pre>
    </div>"""

html_content = html_content.replace("<body>", error_console_body)

# Save bundled file
output_path = os.path.join(output_dir, "Index.html")
with open(output_path, "w", encoding="utf-8") as f:
    f.write(html_content)

print(f"\nGAS Bundler complete. Index.html -> {output_path} ({len(html_content):,} bytes)")

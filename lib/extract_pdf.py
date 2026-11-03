import base64
import io
import json
import pathlib
import sys

vendor = pathlib.Path(__file__).resolve().parent.parent / 'vendor'
sys.path.insert(0, str(vendor))
sys.path.insert(0, str(vendor / 'pypdf.zip'))

try:
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise ValueError('PDF 组件无法加载，请重新复制完整程序目录，或直接粘贴简历正文') from exc
    payload = json.loads(sys.stdin.buffer.read().decode('utf-8'))
    pdf = base64.b64decode(payload['base64'], validate=True)
    if len(pdf) > 6_000_000:
        raise ValueError('PDF 请小于 6 MB')
    reader = PdfReader(io.BytesIO(pdf))
    if reader.is_encrypted:
        raise ValueError('PDF 已加密，请先导出无密码版本')
    if len(reader.pages) > 30:
        raise ValueError('简历 PDF 最多支持 30 页')
    text = '\n\n'.join(page.extract_text() or '' for page in reader.pages).strip()
    if not text:
        raise ValueError('PDF 未包含可提取文字，扫描件请先 OCR 或直接粘贴简历正文')
    result = {'text': text[:100000]}
except Exception as exc:
    result = {'error': str(exc)}
sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode('utf-8'))

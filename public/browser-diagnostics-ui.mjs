export const browserDiagnosticsInstructions = '请先连接正确的 BOSS 消息页，在该页选中一个 HR，点击“查看职位”，保持当前页的职位弹窗打开；再回到本机工作台点击“生成页面诊断”。';

export function createBrowserDiagnosticsAction({api, modal, btn, esc, toast}) {
  return async () => {
    toast('正在生成本机页面诊断…');
    const result = await api('browser/diagnostics', {});
    if (result?.ok !== true || typeof result.path !== 'string' || !result.path.trim())
      throw Error('页面诊断未返回有效的保存位置，请重试');
    const summary = typeof result.summary === 'string' ? result.summary : result.summary ? JSON.stringify(result.summary, null, 2) : '';
    modal('页面诊断已保存', `<p>诊断已保存到本机，没有发送 HR 消息，也没有启动任务。</p>
      <label class="field"><span>本机保存位置</span><input class="control" readonly value="${esc(result.path)}"></label>
      ${summary ? `<div class="section-label">诊断摘要</div><pre class="detail-description" style="white-space:pre-wrap">${esc(summary)}</pre>` : ''}`,
      btn('关闭', 'close-modal', 'primary'));
    toast('页面诊断已保存到本机；未发送 HR 消息，未启动任务。');
    return result;
  };
}

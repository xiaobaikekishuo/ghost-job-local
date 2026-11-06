// Jobs presentation only. Data mutations and event delegation remain in app.js.
import {greetingReviewReason} from './greeting-ui.mjs';
export function createJobListUI({getContext, icon, btn, pill, color, esc, heading, empty}) {
  const filters = ['全部', '待分析', '分析失败', '合适', '不合适', '已沟通', '待补招呼', '招呼待确认', '已分析', '高匹配'];
  const pageSizes = [12, 24, 48];
  let page = 1, pageSize = 12;

  // Site-specific glyphs cannot be decoded without the original page font.
  const hasEncodedGlyphs = value => /[\uE000-\uF8FF]/.test(value || '');
  const readableTitle = value => String(value || '').replace(/\s*[\uE000-\uF8FF][\uE000-\uF8FF\dKkWw\-~薪 ]*/g, '').trim() || '未命名岗位';
  const matchesFilter = (job, filter) => filter === '全部' ||
    filter === '待补招呼' && job.status === '已沟通' && job.greeting?.status === '草稿' ||
    filter === '招呼待确认' && Boolean(greetingReviewReason(job.greeting)) ||
    filter === '已分析' && Boolean(job.analyzedAt) ||
    filter === '高匹配' && job.score != null && Number(job.score) >= 80 ||
    job.status === filter;

  function currentView() {
    const context = getContext();
    const query = String(context.query || '').trim().toLowerCase();
    const searched = context.jobs.filter(job =>
      [job.title, job.company, job.city, job.description].join(' ').toLowerCase().includes(query));
    const filtered = searched.filter(job => matchesFilter(job, context.jobFilter));
    const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
    page = Math.max(1, Math.min(page, pageCount));
    const start = (page - 1) * pageSize;
    return {...context, searched, filtered, pageCount, start, visible: filtered.slice(start, start + pageSize)};
  }

  function filterTabs(view) {
    return `<div class="filter-tabs" aria-label="岗位筛选">${filters.map(filter => {
      const count = view.searched.filter(job => matchesFilter(job, filter)).length;
      return `<button class="${view.jobFilter === filter ? 'active' : ''}" data-action="filter" data-filter="${esc(filter)}" aria-pressed="${view.jobFilter === filter}">${esc(filter)}<span class="filter-count">${count}</span></button>`;
    }).join('')}</div>`;
  }

  function selectionBar(view) {
    const count = view.selected.size;
    return `<div class="jobs-selection-bar${count ? ' has-selection' : ''}">
      <div class="jobs-selection-count"><span>已选择 <strong data-job-selected-count>${count}</strong> 个岗位</span><small data-job-selection-hint>${count ? '已选岗位可跨页保留' : '勾选岗位后批量操作'}</small><button class="text-btn" data-action="clear-job-selection" ${count ? '' : 'hidden'}>取消选择</button></div>
      <div class="inline-actions">${btn('批量分析', 'analyze-selected', 'soft', 'spark', count ? '' : 'disabled')}${btn('删除选中', 'delete-selected', '', 'trash', count ? '' : 'disabled')}</div>
    </div>`;
  }

  function pagination(view) {
    const {filtered, pageCount, start, visible} = view;
    const numbers = [...new Set([1, page - 2, page - 1, page, page + 1, page + 2, pageCount])]
      .filter(number => number >= 1 && number <= pageCount).sort((a, b) => a - b);
    const pageButtons = filtered.length ? numbers.map((number, index) => {
      const gap = index && number - numbers[index - 1] > 1 ? '<span class="jobs-page-ellipsis" aria-hidden="true">…</span>' : '';
      return `${gap}<button class="jobs-page-number${number === page ? ' active' : ''}" data-action="jobs-page" data-page="${number}" aria-label="第 ${number} 页" ${number === page ? 'aria-current="page" disabled' : ''}>${number}</button>`;
    }).join('') : '';
    return `<div class="table-footer jobs-pagination">
      <span>${filtered.length ? `显示第 ${start + 1}–${start + visible.length} 项，共 ${filtered.length} 个岗位` : '共 0 个岗位'}</span>
      <label class="jobs-page-size">每页 <select id="job-page-size" aria-label="每页岗位数">${pageSizes.map(size => `<option value="${size}" ${size === pageSize ? 'selected' : ''}>${size}</option>`).join('')}</select> 个</label>
      <nav class="jobs-page-controls" aria-label="岗位分页">${btn('上一页', 'jobs-page', '', '', `data-page="${page - 1}" ${page === 1 ? 'disabled' : ''}`)}${pageButtons}${btn('下一页', 'jobs-page', '', '', `data-page="${page + 1}" ${page === pageCount ? 'disabled' : ''}`)}</nav>
    </div>`;
  }

  function row(job, view) {
    const company = (view.state.companies || []).find(company => company.name === job.company);
    const title = readableTitle(job.title);
    const encodedSalary = hasEncodedGlyphs(job.salary);
    const greetingReview = greetingReviewReason(job.greeting);
    return `<tr>
      <td><input type="checkbox" data-select="${esc(job.id)}" ${view.selected.has(job.id) ? 'checked' : ''} aria-label="选择 ${esc(title)}"></td>
      <td><button class="text-btn job-title" data-action="job-detail" data-id="${esc(job.id)}">${esc(title)}</button><span class="sub">${esc(job.company || '公司待补充')} · ${esc(job.city || '城市未知')}</span>${company ? pill(company.risk, company.risk === '高风险' ? 'red' : '') : ''}${job.simulation ? pill('虚构', 'orange') : ''}${job.listKind === '首页推荐' ? pill('首页推荐') : ''}</td>
      <td><b class="salary" ${encodedSalary ? 'title="原页面薪资使用特殊字体，请打开原岗位核实"' : ''}>${esc(!job.salary || encodedSalary ? '待核实' : job.salary)}</b><span class="sub">${esc(job.hrActivity || '活跃度未知')}</span></td>
      <td>${job.score == null ? '<span class="unscored">未评分</span>' : `<div class="score">${esc(job.score)}<i><b style="width:${Math.min(100, Math.max(0, Number(job.score) || 0))}%"></b></i></div>`}</td>
      <td>${pill(job.status, color(job.status))}<span class="sub reason" title="${esc(job.reason || '尚未分析')}">${esc(job.reason || '尚未分析')}</span></td>
      <td>${pill(job.stage || '未标记', color(job.stage))}${greetingReview ? `<span class="sub">${pill('招呼待确认', 'orange')}</span><span class="sub reason" title="${esc(greetingReview)}">${esc(greetingReview)}</span>` : job.status === '已沟通' && job.greeting?.status === '草稿' ? `<span class="sub">${pill('待补招呼', 'orange')}</span>` : ''}${job.greeting?.status === '待核实' ? `<span class="sub">${pill('招呼待核实', 'orange')}</span>` : ''}</td>
      <td><div class="actions"><button class="text-btn" data-action="job-detail" data-id="${esc(job.id)}">${greetingReview ? '检查招呼' : '详情'}</button><button class="text-btn company-action" data-action="company-query" data-id="${esc(job.id)}" aria-label="查询 ${esc(job.company || title)} 的企业信息" title="企业查询">${icon('search')}</button></div></td>
    </tr>`;
  }

  function jobRows() {
    const view = currentView();
    const {jobs, selected, filtered, visible} = view;
    const selectedOnPage = visible.filter(job => selected.has(job.id)).length;
    const controls = `<div class="jobs-list-controls">${filterTabs(view)}<div class="jobs-result-count" role="status" aria-live="polite">匹配 ${filtered.length} 个岗位 · 全部 ${jobs.length} 个</div>${selectionBar(view)}</div>`;
    if (!filtered.length) {
      return controls + empty(jobs.length ? '没有找到匹配的岗位' : '从第一份机会开始', jobs.length ? '试试其他关键词，或重置筛选条件。' : '读取浏览器中的岗位，或手动添加你的意向机会。', 'briefcase', `<div class="inline-actions">${btn('添加岗位', 'add-job', 'primary', 'plus')}${btn('重置筛选', 'reset-job-filters', '', 'refresh')}</div>`) + pagination(view);
    }
    return controls + `<div class="table-wrap"><table><thead><tr>
      <th><input type="checkbox" id="select-all" aria-label="选择当前页岗位" aria-checked="${selectedOnPage === visible.length ? 'true' : selectedOnPage ? 'mixed' : 'false'}" ${selectedOnPage === visible.length ? 'checked' : ''}></th>
      <th>岗位 / 公司</th><th>薪资 / 活跃度</th><th>匹配分</th><th>筛选结果 / 理由</th><th>沟通状态</th><th>操作</th>
    </tr></thead><tbody>${visible.map(job => row(job, view)).join('')}</tbody></table></div>` + pagination(view);
  }

  function jobsPage() {
    const {jobs, query, selected} = getContext();
    const summary = [
      ['briefcase', '全部', jobs.length],
      ['clock', '待分析', jobs.filter(job => job.status === '待分析').length],
      ['check', '合适', jobs.filter(job => job.status === '合适').length]
    ];
    const exportLabel = `<span data-job-export-label>${selected.size ? '导出选中' : '导出全部'}</span>`;
    return heading('岗位管理', `共 ${jobs.length} 个岗位 · 把每个机会整理清楚，再做决定。`, `<div class="inline-actions">${btn('导入', 'import', '', 'upload')}${btn(exportLabel, 'export-jobs', '', 'download')}${btn('添加岗位', 'add-job', 'primary', 'plus')}</div>`) + `
      <div class="jobs-summary" aria-label="岗位概览">${summary.map(([name, label, value]) => `<div class="job-summary"><span class="stat-icon">${icon(name)}</span><div><span class="summary-label">${label}</span><strong class="summary-value">${value}</strong></div></div>`).join('')}</div>
      <section class="panel jobs-panel"><div class="jobs-toolbar"><div class="toolbar-top"><div class="search">${icon('search')}<input id="job-search" placeholder="搜索岗位、公司、城市或描述" value="${esc(query)}" aria-label="搜索岗位"></div></div></div><div id="job-table">${jobRows()}</div></section>
      <div class="setup-note">${icon('info')}<span>筛选结果与沟通状态保存在本机，完整信息与理由可在详情中查看。</span><button data-action="collect">读取当前页岗位 →</button></div>`;
  }

  function resetPage() {
    page = 1;
    return page;
  }

  function changePage(value) {
    const next = Number(value);
    if (Number.isFinite(next)) page = Math.max(1, Math.floor(next));
    currentView();
    return page;
  }

  function changePageSize(value) {
    const next = Number(value);
    if (pageSizes.includes(next)) {
      pageSize = next;
      resetPage();
    }
    return pageSize;
  }

  function updateSelection(root = globalThis.document) {
    const {selected} = getContext(), count = selected.size;
    if (!root?.querySelectorAll) return count;
    root.querySelectorAll('[data-job-selected-count]').forEach(element => { element.textContent = String(count); });
    root.querySelectorAll('[data-job-selection-hint]').forEach(element => { element.textContent = count ? '已选岗位可跨页保留' : '勾选岗位后批量操作'; });
    root.querySelectorAll('[data-action="clear-job-selection"]').forEach(button => { button.hidden = !count; });
    root.querySelectorAll('.jobs-selection-bar').forEach(element => { element.classList.toggle('has-selection', count > 0); });
    root.querySelectorAll('[data-action="analyze-selected"], [data-action="delete-selected"]').forEach(button => { button.disabled = !count; });
    root.querySelectorAll('[data-job-export-label]').forEach(element => { element.textContent = count ? '导出选中' : '导出全部'; });
    const checkboxes = [...root.querySelectorAll('#job-table [data-select]')];
    checkboxes.forEach(checkbox => { checkbox.checked = selected.has(checkbox.dataset.select); });
    const selectAll = root.querySelector('#select-all');
    if (selectAll) {
      const checked = checkboxes.filter(checkbox => checkbox.checked).length;
      selectAll.checked = checkboxes.length > 0 && checked === checkboxes.length;
      selectAll.indeterminate = checked > 0 && checked < checkboxes.length;
      selectAll.setAttribute('aria-checked', selectAll.indeterminate ? 'mixed' : String(selectAll.checked));
    }
    return count;
  }

  return {jobsPage, jobRows, resetPage, changePage, changePageSize, updateSelection};
}

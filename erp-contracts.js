// ============================================================
// Revise v15.0 — erp-contracts.js
// المقايسة (BOQ) + المستخلصات التراكمية + الأوامر التغييرية
// + العملاء وحجز الضمان + خطابات الضمان + طباعة/PDF المستخلص
// سري 100%: لا يُحمّل ولا يقرأ إلا للمدير أو المحاسب المسموح له (canAccessErp)
// ============================================================

export const COST_GROUPS = ['خامات', 'عمالة', 'مقاولين باطن', 'معدات', 'مصاريف موقع'];

let core = null;
let unsubs = [];
let initialized = false;
let contractsMap = new Map();
let statementsList = [];

const ui = {
  pid: null,
  subTab: 'over',
  stmtPid: null,
  stmtId: null,
  activeView: null
};

const fmtNum = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtMoney = (n) => `${fmtNum(n)} ج`;
const fmtPct = (n) => `${(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-US')}%`;
const genId = (pref = 'id') => `${pref}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;

function daysUntil(iso) {
  if (!iso) return null;
  const today = core.getLocalDateStr();
  const a = new Date(iso + 'T00:00:00').getTime();
  const b = new Date(today + 'T00:00:00').getTime();
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

function shiftYear(iso, years = 1) {
  if (!iso) return '';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return '';
  d.setFullYear(d.getFullYear() + years);
  return core.getLocalDateStr(d);
}

function defaultContract(pid) {
  const budget = {};
  COST_GROUPS.forEach((g) => { budget[g] = 0; });
  return {
    projectId: pid,
    client: '',
    location: '',
    status: 'جارٍ التنفيذ',
    startDate: core ? core.getLocalDateStr() : '',
    advancePct: 0,
    retentionPct: 0,
    boq: [],
    changeOrders: [],
    budget,
    phases: [
      { id: 'ph1', name: 'التجهيز والأساسات', planned: 0, actual: 0 },
      { id: 'ph2', name: 'الأعمال الرئيسية', planned: 0, actual: 0 },
      { id: 'ph3', name: 'التشطيبات', planned: 0, actual: 0 },
      { id: 'ph4', name: 'التسليم', planned: 0, actual: 0 }
    ],
    guarantees: [],
    handover: { initial: '', initialExpected: '', final: '', finalExpected: '', notes: [] },
    approvedSiteQtys: {}
  };
}

export function getContract(pid) {
  const base = defaultContract(pid);
  const saved = contractsMap.get(pid);
  if (!saved) return base;
  return {
    ...base,
    ...saved,
    budget: { ...base.budget, ...(saved.budget || {}) },
    handover: { ...base.handover, ...(saved.handover || {}), notes: Array.isArray(saved.handover?.notes) ? saved.handover.notes : [] },
    boq: Array.isArray(saved.boq) ? saved.boq : [],
    changeOrders: Array.isArray(saved.changeOrders) ? saved.changeOrders : [],
    phases: Array.isArray(saved.phases) && saved.phases.length ? saved.phases : base.phases,
    guarantees: Array.isArray(saved.guarantees) ? saved.guarantees : [],
    approvedSiteQtys: { ...(saved.approvedSiteQtys || {}) }
  };
}

export function getAllContractsMap() {
  return contractsMap;
}

export function getAllStatements() {
  return statementsList;
}

export function getEffectiveBoq(pid) {
  const c = getContract(pid);
  const map = new Map();
  c.boq.forEach((it) => {
    map.set(it.id, {
      id: it.id,
      name: it.name || '',
      unit: it.unit || 'مقطوعية',
      qty: Number(it.qty || 0),
      price: Number(it.price || 0),
      isNewFromCo: false
    });
  });
  c.changeOrders.forEach((co) => {
    (co.items || []).forEach((ci) => {
      if (ci.newItem && ci.newItem.id) {
        const ex = map.get(ci.newItem.id);
        if (ex) {
          ex.qty = core.round2(ex.qty + Number(ci.delta || 0));
        } else {
          map.set(ci.newItem.id, {
            id: ci.newItem.id,
            name: ci.newItem.name || '',
            unit: ci.newItem.unit || 'مقطوعية',
            qty: core.round2(Number(ci.delta || ci.newItem.qty || 0)),
            price: Number(ci.newItem.price || 0),
            isNewFromCo: true
          });
        }
      } else if (ci.boqId && map.has(ci.boqId)) {
        const it = map.get(ci.boqId);
        it.qty = core.round2(it.qty + Number(ci.delta || 0));
      }
    });
  });
  return [...map.values()];
}

export function getBaseContractValue(pid) {
  const c = getContract(pid);
  return core.round2(c.boq.reduce((s, it) => s + Number(it.qty || 0) * Number(it.price || 0), 0));
}

export function getChangeOrdersTotal(pid) {
  const c = getContract(pid);
  const baseMap = new Map(c.boq.map((b) => [b.id, b]));
  let total = 0;
  c.changeOrders.forEach((co) => {
    (co.items || []).forEach((ci) => {
      if (ci.newItem) {
        total += Number(ci.delta || 0) * Number(ci.newItem.price || 0);
        baseMap.set(ci.newItem.id, ci.newItem);
      } else if (ci.boqId) {
        const it = baseMap.get(ci.boqId);
        total += Number(ci.delta || 0) * Number(it?.price || 0);
      }
    });
  });
  return core.round2(total);
}

export function getContractValue(pid) {
  return core.round2(getBaseContractValue(pid) + getChangeOrdersTotal(pid));
}

export function getProjectStatements(pid) {
  return statementsList
    .filter((s) => s.projectId === pid)
    .sort((a, b) => Number(a.no || 0) - Number(b.no || 0));
}

export function calcStatementRaw(pid, stmt) {
  const c = getContract(pid);
  const boq = getEffectiveBoq(pid);
  const qtys = stmt?.qtys || {};
  let gross = 0;
  const lines = boq.map((it) => {
    const exec = Number(qtys[it.id] || 0);
    const value = core.round2(exec * Number(it.price || 0));
    gross = core.round2(gross + value);
    const pct = it.qty > 0 ? (exec / it.qty) * 100 : 0;
    return { ...it, exec, value, pct };
  });
  const baseCv = getBaseContractValue(pid);
  const advTotal = core.round2(baseCv * (Number(c.advancePct || 0) / 100));
  const retention = core.round2(gross * (Number(c.retentionPct || 0) / 100));
  const advRec = advTotal > 0 ? core.round2(Math.min(gross * (Number(c.advancePct || 0) / 100), advTotal)) : 0;
  const netBeforeExtras = core.round2(gross - retention - advRec);
  const extras = Array.isArray(stmt?.extraDeductions) ? stmt.extraDeductions : [];
  const extraDeductionsTotal = core.round2(extras.reduce((s, x) => s + Math.max(0, Number(x.amount || 0)), 0));
  return { lines, gross, retention, advTotal, advRec, netBeforeExtras, extras, extraDeductionsTotal };
}

export function calcStatementDue(pid, stmt) {
  const raw = calcStatementRaw(pid, stmt);
  const allSt = getProjectStatements(pid);
  const prevList = allSt.filter((s) => Number(s.no || 0) < Number(stmt.no || 0));
  const prevStmt = prevList.length ? prevList[prevList.length - 1] : null;
  const prevRaw = prevStmt ? calcStatementRaw(pid, prevStmt) : null;
  const prevNetBeforeExtras = prevRaw ? prevRaw.netBeforeExtras : 0;
  const prevGross = prevRaw ? prevRaw.gross : 0;
  const currentGrossDelta = core.round2(raw.gross - prevGross);
  const currentBeforeExtras = core.round2(raw.netBeforeExtras - prevNetBeforeExtras);
  const dueNow = core.round2(currentBeforeExtras - raw.extraDeductionsTotal);
  const linesWithPrev = raw.lines.map((l) => {
    const prevExec = prevStmt ? Number(prevStmt.qtys?.[l.id] || 0) : 0;
    return { ...l, prevExec, deltaExec: core.round2(l.exec - prevExec) };
  });
  return {
    ...raw,
    lines: linesWithPrev,
    prevGross,
    currentGrossDelta,
    prevNetBeforeExtras,
    currentBeforeExtras,
    dueNow
  };
}

export function getProjectFinancials(pid) {
  const c = getContract(pid);
  const baseCv = getBaseContractValue(pid);
  const coTot = getChangeOrdersTotal(pid);
  const cv = core.round2(baseCv + coTot);
  const sts = getProjectStatements(pid);
  const last = sts.length ? sts[sts.length - 1] : null;
  const lastRaw = last ? calcStatementRaw(pid, last) : { gross: 0, retention: 0, advTotal: core.round2(baseCv * (Number(c.advancePct || 0) / 100)), advRec: 0, netBeforeExtras: 0 };

  let totalExtraDeductions = 0;
  sts.forEach((s) => {
    const ex = Array.isArray(s.extraDeductions) ? s.extraDeductions : [];
    totalExtraDeductions = core.round2(totalExtraDeductions + ex.reduce((a, x) => a + Math.max(0, Number(x.amount || 0)), 0));
  });
  const certifiedNet = core.round2(lastRaw.netBeforeExtras - totalExtraDeductions);

  // المقبوضات الفعلية من دفتر v14 الحقيقي (بدون أرقام وهمية)
  const paidTxs = core.getAllTxs().filter((t) => t.projectId === pid && core.isProjectCashIncome(t));
  const paid = core.round2(paidTxs.reduce((s, t) => s + Number(t.amount || 0), 0));
  const balance = core.round2(certifiedNet - paid);

  // التكاليف الفعلية لحظياً من دفتر v14
  let costs = 0;
  if (window.ReviseErpSite && typeof window.ReviseErpSite.computeProjectActualCosts === 'function') {
    costs = window.ReviseErpSite.computeProjectActualCosts(pid).total;
  } else {
    costs = core.round2(core.getAllTxs().filter((t) => t.projectId === pid && core.isProjectCashExpense(t)).reduce((s, t) => s + Number(t.amount || 0), 0));
  }
  const budget = core.round2(COST_GROUPS.reduce((s, g) => s + Number(c.budget[g] || 0), 0));
  const progress = cv > 0 ? (lastRaw.gross / cv) * 100 : 0;
  const spentPct = budget > 0 ? (costs / budget) * 100 : 0;
  const margin = core.round2(lastRaw.gross - costs);

  // قيمة الأعمال المعتمدة من الموقع مقارنة بالمستخلص الأخير (حتى لا تُنسى كمية معتمدة)
  const effBoq = getEffectiveBoq(pid);
  let siteApprovedValue = 0;
  effBoq.forEach((it) => {
    const q = Math.max(Number(c.approvedSiteQtys?.[it.id] || 0), Number(last?.qtys?.[it.id] || 0));
    siteApprovedValue = core.round2(siteApprovedValue + q * Number(it.price || 0));
  });
  const unbilledApprovedValue = core.round2(Math.max(0, siteApprovedValue - lastRaw.gross));

  return {
    cv, baseCv, coTot, last,
    gross: lastRaw.gross,
    retention: lastRaw.retention,
    advTotal: lastRaw.advTotal,
    advRec: lastRaw.advRec,
    advRemain: core.round2(Math.max(0, lastRaw.advTotal - lastRaw.advRec)),
    totalExtraDeductions,
    certifiedNet,
    paid,
    paidTxs,
    balance,
    progress,
    costs,
    budget,
    spentPct,
    margin,
    siteApprovedValue,
    unbilledApprovedValue
  };
}

export function getRetentionSchedule(pid) {
  const c = getContract(pid);
  const f = getProjectFinancials(pid);
  if (f.retention <= 0) return [];
  const h = c.handover || {};
  if (Number(c.retentionPct || 0) <= 5) {
    return [{ label: 'يُرد كاملاً بعد الاستلام النهائي', date: h.final || h.finalExpected || '', amount: f.retention }];
  }
  const firstDate = h.initial || h.initialExpected || '';
  const secondDate = h.final || h.finalExpected || (firstDate ? shiftYear(firstDate, 1) : '');
  return [
    { label: 'النصف الأول — عند الاستلام الابتدائي', date: firstDate, amount: core.round2(f.retention / 2) },
    { label: 'النصف الثاني — بعد انتهاء سنة الضمان', date: secondDate, amount: core.round2(f.retention / 2) }
  ];
}

// مزامنة نسخة المقايسة للموقع (خالية 100% من أي أسعار بيع أو أرباح)
export function buildSiteBoqPayload(pid, contractOverride = null) {
  const c = contractOverride || getContract(pid);
  // حساب المقايسة الفعالة من الكائن الممرر
  const map = new Map();
  (c.boq || []).forEach((it) => {
    map.set(it.id, { id: it.id, name: it.name || '', unit: it.unit || 'مقطوعية', contractQty: Number(it.qty || 0) });
  });
  (c.changeOrders || []).forEach((co) => {
    (co.items || []).forEach((ci) => {
      if (ci.newItem && ci.newItem.id) {
        const ex = map.get(ci.newItem.id);
        if (ex) ex.contractQty = core.round2(ex.contractQty + Number(ci.delta || 0));
        else map.set(ci.newItem.id, { id: ci.newItem.id, name: ci.newItem.name || '', unit: ci.newItem.unit || 'مقطوعية', contractQty: core.round2(Number(ci.delta || ci.newItem.qty || 0)) });
      } else if (ci.boqId && map.has(ci.boqId)) {
        const it = map.get(ci.boqId);
        it.contractQty = core.round2(it.contractQty + Number(ci.delta || 0));
      }
    });
  });

  const sts = getProjectStatements(pid);
  const lastQtys = sts.length ? (sts[sts.length - 1].qtys || {}) : {};
  const approvedQtys = c.approvedSiteQtys || {};

  const items = [...map.values()].map((it) => ({
    id: it.id,
    name: it.name,
    unit: it.unit,
    contractQty: it.contractQty,
    executedQty: core.round2(Math.max(Number(approvedQtys[it.id] || 0), Number(lastQtys[it.id] || 0)))
  }));

  return {
    projectId: pid,
    items,
    updatedAt: core.fs.serverTimestamp()
  };
}

export async function saveContractDoc(pid, nextContract, auditSummary) {
  const { doc, writeBatch, serverTimestamp } = core.fs;
  const beforeObj = contractsMap.get(pid) || null;
  const cleanPayload = {
    projectId: pid,
    client: String(nextContract.client || '').trim(),
    location: String(nextContract.location || '').trim(),
    status: String(nextContract.status || 'جارٍ التنفيذ'),
    startDate: String(nextContract.startDate || ''),
    advancePct: Math.max(0, Math.min(90, Number(nextContract.advancePct || 0))),
    retentionPct: Math.max(0, Math.min(25, Number(nextContract.retentionPct || 0))),
    boq: Array.isArray(nextContract.boq) ? nextContract.boq : [],
    changeOrders: Array.isArray(nextContract.changeOrders) ? nextContract.changeOrders : [],
    budget: nextContract.budget || defaultContract(pid).budget,
    phases: Array.isArray(nextContract.phases) ? nextContract.phases : defaultContract(pid).phases,
    guarantees: Array.isArray(nextContract.guarantees) ? nextContract.guarantees : [],
    handover: nextContract.handover || defaultContract(pid).handover,
    approvedSiteQtys: nextContract.approvedSiteQtys || {},
    updatedBy: core.getUser().uid,
    updatedByName: core.getUserName(),
    updatedAt: serverTimestamp()
  };

  const batch = writeBatch(core.db);
  batch.set(doc(core.db, 'project_contracts', pid), cleanPayload);
  batch.set(doc(core.db, 'project_site_boq', pid), buildSiteBoqPayload(pid, cleanPayload));
  if (core.isAdmin() && auditSummary) {
    core.addAuditToBatch(batch, beforeObj ? 'update' : 'create', 'project_contracts', pid, beforeObj, cleanPayload, auditSummary);
  }
  await batch.commit();
}

function getActiveProjectsList() {
  return core.getProjects().filter((p) => !p.archived);
}

function ensureSelectedPid(preferredPid = null) {
  const list = getActiveProjectsList();
  if (preferredPid && core.getProjects().some((p) => p.id === preferredPid)) {
    ui.pid = preferredPid;
    return ui.pid;
  }
  if (ui.pid && core.getProjects().some((p) => p.id === ui.pid)) return ui.pid;
  ui.pid = list[0]?.id || core.getProjects()[0]?.id || null;
  return ui.pid;
}

function projNameById(pid) {
  return core.getProjects().find((p) => p.id === pid)?.name || 'مشروع';
}

/* ============ شاشات العقود والمستخلصات والعملاء والضمانات ============ */
export function renderView(viewName, opts = {}) {
  if (!core.canAccessErp()) {
    return '<div class="card"><p style="color:var(--red); text-align:center;">🔒 هذه الشاشة مخصصة للمدير أو المحاسب الموثوق فقط.</p></div>';
  }
  ui.activeView = viewName;
  if (opts.projectId) ui.pid = opts.projectId;
  if (opts.subTab) ui.subTab = opts.subTab;
  if (viewName === 'contracts') return renderContractHub();
  if (viewName === 'statements') return renderStatementsScreen();
  if (viewName === 'clients') return renderClientsScreen();
  if (viewName === 'guarantees') return renderGuaranteesScreen();
  return renderContractHub();
}

function renderContractHub() {
  const allProjs = core.getProjects();
  if (!allProjs.length) {
    return '<div class="card"><p style="color:var(--muted); text-align:center;">أضف مشروعاً من تبويب «📂 التصنيفات» أولاً لفتح ملف عقده ومقايسته.</p></div>';
  }
  const pid = ensureSelectedPid(ui.pid);
  const pName = projNameById(pid);
  const c = getContract(pid);
  const f = getProjectFinancials(pid);

  const projSelector = `
    <div class="card" style="padding:12px;">
      <div class="between" style="margin-bottom:6px;">
        <strong style="font-size:14px; color:var(--primary);">📑 ملف العقد والمقايسة</strong>
        <span class="erp-chip brand">${core.esc(c.status)}</span>
      </div>
      <select data-ec-action="selectProj">
        ${allProjs.map((p) => `<option value="${core.esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${core.esc(p.name)}${p.archived ? ' (مؤرشف)' : ''}</option>`).join('')}
      </select>
      <div style="font-size:12px; color:var(--muted); margin-top:6px;">
        ${c.client ? `العميل: <strong>${core.esc(c.client)}</strong>` : 'لم يُحدد اسم العميل بعد'}
        ${c.location ? ` • ${core.esc(c.location)}` : ''}
        ${c.startDate ? ` • بدأ ${core.esc(c.startDate)}` : ''}
      </div>
      <div class="hero-card" style="margin-top:10px; margin-bottom:0; padding:12px;">
        <div class="hero-grid" style="margin-top:0;">
          <div class="hero-sub"><small>قيمة العقد الحالية</small><strong style="color:#facc15;">${fmtMoney(f.cv)}</strong></div>
          <div class="hero-sub"><small>أعمال منفذة (${fmtPct(f.progress)})</small><strong style="color:#34d399;">${fmtMoney(f.gross)}</strong></div>
          <div class="hero-sub"><small>مستحق عند العميل</small><strong style="color:${f.balance > 0 ? '#fbbf24' : '#34d399'};">${fmtMoney(f.balance)}</strong></div>
          <div class="hero-sub"><small>حجز ضمان (${fmtPct(c.retentionPct)})</small><strong>${fmtMoney(f.retention)}</strong></div>
        </div>
        ${f.unbilledApprovedValue > 0 ? `<div style="margin-top:8px; font-size:11.5px; color:#fde047;">💡 يوجد أعمال معتمدة من الموقع بقيمة <strong>${fmtMoney(f.unbilledApprovedValue)}</strong> لم تدخل في مستخلص بعد.</div>` : ''}
      </div>
    </div>`;

  const subTabs = [
    ['over', '📋 بيانات العقد والتسليم'],
    ['boq', `📐 المقايسة (${getEffectiveBoq(pid).length})`],
    ['changes', `✏️ التغييرية (${c.changeOrders.length})`],
    ['statements', `🧾 المستخلصات (${getProjectStatements(pid).length})`],
    ['guarantees', `🛡️ الضمان (${c.guarantees.length})`]
  ];
  const tabsBar = `<div class="erp-subtabs">${subTabs.map(([k, lbl]) =>
    `<button type="button" class="erp-tab ${ui.subTab === k ? 'active' : ''}" data-ec-subtab="${k}">${lbl}</button>`
  ).join('')}</div>`;

  let body = '';
  if (ui.subTab === 'over') body = renderSubOverview(pid, c, f);
  else if (ui.subTab === 'boq') body = renderSubBoq(pid, c, f);
  else if (ui.subTab === 'changes') body = renderSubChanges(pid, c);
  else if (ui.subTab === 'statements') body = renderProjectStatementsCard(pid);
  else if (ui.subTab === 'guarantees') body = renderProjectGuaranteesCard(pid, c);

  return `<div class="erp-shell">${projSelector}${tabsBar}${body}</div>`;
}

function renderSubOverview(pid, c, f) {
  const sched = getRetentionSchedule(pid);
  const h = c.handover || {};
  const phasesHtml = c.phases.map((ph, idx) => {
    const lag = Number(ph.actual || 0) < Number(ph.planned || 0);
    return `<div style="margin-bottom:10px;">
      <div class="between" style="font-size:12.5px;">
        <strong>${core.esc(ph.name)}</strong>
        <div>
          <span style="color:var(--muted);">مخطط ${Number(ph.planned || 0)}%</span> •
          <strong>فعلي ${Number(ph.actual || 0)}%</strong>
          <span class="erp-chip ${lag ? 'amber' : 'green'}">${lag ? 'متأخر ' + (Number(ph.planned) - Number(ph.actual)) + '%' : 'في الموعد'}</span>
        </div>
      </div>
      <div class="erp-barwrap">
        <div class="erp-bar"><i class="${lag ? 'amber' : ''}" style="width:${Math.min(100, Number(ph.actual || 0))}%"></i></div>
        <div class="erp-barmark" style="inset-inline-start:${Math.min(100, Number(ph.planned || 0))}%"></div>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="card">
      <div class="between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:14.5px;">⚙️ شروط العقد الأساسية</h3>
        <button type="button" class="sm gold" data-ec-modal="editContract" data-pid="${core.esc(pid)}">✏️ تعديل البيانات</button>
      </div>
      <div class="erp-sumbox" style="margin-top:0;">
        <div class="erp-sumline"><span>قيمة العقد الأصلية</span><strong>${fmtMoney(f.baseCv)}</strong></div>
        <div class="erp-sumline"><span>الأوامر التغييرية</span><strong class="${f.coTot < 0 ? 'erp-neg' : 'erp-pos'}">${f.coTot >= 0 ? '+' : ''}${fmtMoney(f.coTot)}</strong></div>
        <div class="erp-sumline"><span>نسبة الدفعة المقدمة</span><strong>${fmtPct(c.advancePct)} (${fmtMoney(f.advTotal)})</strong></div>
        <div class="erp-sumline"><span>نسبة حجز الضمان</span><strong>${fmtPct(c.retentionPct)} (محتجز: ${fmtMoney(f.retention)})</strong></div>
        <div class="erp-sumline total"><span>المقبوض فعلياً (من دفتر v14)</span><strong class="erp-pos">${fmtMoney(f.paid)}</strong></div>
      </div>
    </div>

    <div class="card">
      <div class="between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:14.5px;">📊 مراحل التنفيذ (مخطط مقابل فعلي)</h3>
        <button type="button" class="sm secondary" data-ec-modal="editPhases" data-pid="${core.esc(pid)}">✏️ تحديث النسب</button>
      </div>
      ${phasesHtml}
      <small style="color:var(--muted);">العلامة الرأسية = المخطط، والشريط الملون = المنفذ فعلياً.</small>
    </div>

    <div class="card">
      <div class="between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:14.5px;">🏁 التسليم ومواعيد رد حجز الضمان</h3>
        <button type="button" class="sm secondary" data-ec-modal="editHandover" data-pid="${core.esc(pid)}">✏️ تعديل المحضر</button>
      </div>
      <div class="erp-sumbox" style="margin-top:0;">
        <div class="erp-sumline"><span>الاستلام الابتدائي</span><strong>${h.initial ? core.esc(h.initial) + ' ✅' : (h.initialExpected ? 'متوقع ' + core.esc(h.initialExpected) : 'لم يُحدد')}</strong></div>
        <div class="erp-sumline"><span>الاستلام النهائي</span><strong>${h.final ? core.esc(h.final) + ' ✅' : (h.finalExpected ? 'متوقع ' + core.esc(h.finalExpected) : 'لم يُحدد')}</strong></div>
      </div>
      ${sched.length ? `<div style="margin-top:8px;"><strong style="font-size:12.5px; display:block; margin-bottom:4px;">مواعيد استرداد حجز الضمان:</strong>${sched.map((r) => `<div class="erp-sumline" style="font-size:12px;"><span>${core.esc(r.label)}</span><strong>${fmtMoney(r.amount)}${r.date ? ' • ' + core.esc(r.date) : ''}</strong></div>`).join('')}</div>` : ''}
      ${(h.notes && h.notes.length) ? `<div style="margin-top:8px;"><strong style="font-size:12.5px; color:var(--orange);">ملاحظات محضر الاستلام (${h.notes.length}):</strong>${h.notes.map((n) => `<div style="font-size:12px; color:var(--muted); margin-top:3px;">• ${core.esc(n)}</div>`).join('')}</div>` : ''}
    </div>`;
}

function renderSubBoq(pid, c, f) {
  const boq = getEffectiveBoq(pid);
  const lastQtys = f.last?.qtys || {};
  const siteQtys = c.approvedSiteQtys || {};
  const rows = boq.map((it) => {
    const stmtQ = Number(lastQtys[it.id] || 0);
    const siteQ = Math.max(Number(siteQtys[it.id] || 0), stmtQ);
    const baseExists = c.boq.some((b) => b.id === it.id);
    return `<tr>
      <td class="head" data-l="البند">${core.esc(it.name)} ${it.isNewFromCo ? '<span class="erp-chip brand">أمر تغييري</span>' : ''}</td>
      <td data-l="الوحدة">${core.esc(it.unit)}</td>
      <td class="r" data-l="كمية العقد">${fmtNum(it.qty)}</td>
      <td class="r" data-l="سعر الوحدة">${fmtMoney(it.price)}</td>
      <td class="r" data-l="قيمة العقد"><strong>${fmtMoney(it.qty * it.price)}</strong></td>
      <td class="r" data-l="بالمستخلص / بالموقع">${fmtNum(stmtQ)} / <strong style="color:var(--primary);">${fmtNum(siteQ)}</strong></td>
      <td data-l="إجراء">${baseExists ? `<button type="button" class="sm secondary" data-ec-modal="editBoq" data-pid="${core.esc(pid)}" data-bid="${core.esc(it.id)}">✏️</button> <button type="button" class="sm red" data-ec-delboq="${core.esc(it.id)}" data-pid="${core.esc(pid)}">×</button>` : '<small style="color:var(--muted);">من أمر تغييري</small>'}</td>
    </tr>`;
  }).join('');

  return `<div class="card">
    <div class="between" style="margin-bottom:6px; flex-wrap:wrap;">
      <h3 style="margin:0; font-size:14.5px;">📐 بنود المقايسة (BOQ)</h3>
      <button type="button" class="sm gold" data-ec-modal="addBoq" data-pid="${core.esc(pid)}">+ إضافة بند</button>
    </div>
    <small style="color:var(--muted); display:block; margin-bottom:6px;">تُزامَن أسماء البنود والكميات فقط (بدون أسعار البيع) تلقائياً لشاشة مهندس الموقع.</small>
    <div class="erp-tblwrap">
      <table class="erp-tbl">
        <thead><tr><th>البند</th><th>الوحدة</th><th class="r">كمية العقد</th><th class="r">السعر</th><th class="r">إجمالي العقد</th><th class="r">مستخلص / موقع</th><th>إجراء</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="7" style="text-align:center; color:var(--muted);">لا توجد بنود في المقايسة بعد — اضغط «+ إضافة بند».</td></tr>'}</tbody>
        <tfoot><tr><td colspan="4">إجمالي قيمة العقد (بعد التعديلات)</td><td class="r">${fmtMoney(f.cv)}</td><td colspan="2"></td></tr></tfoot>
      </table>
    </div>
  </div>`;
}

function renderSubChanges(pid, c) {
  const eff = getEffectiveBoq(pid);
  const effMap = new Map(eff.map((x) => [x.id, x]));
  const itemsHtml = c.changeOrders.map((co) => {
    let coVal = 0;
    const det = (co.items || []).map((ci) => {
      if (ci.newItem) {
        coVal += Number(ci.delta || 0) * Number(ci.newItem.price || 0);
        return `بند مستحدث: ${core.esc(ci.newItem.name)} (${fmtNum(ci.delta)} ${core.esc(ci.newItem.unit)} × ${fmtMoney(ci.newItem.price)})`;
      }
      const it = effMap.get(ci.boqId) || c.boq.find((b) => b.id === ci.boqId);
      coVal += Number(ci.delta || 0) * Number(it?.price || 0);
      return `${Number(ci.delta) >= 0 ? 'زيادة' : 'خصم'}: ${core.esc(it?.name || ci.boqId)} (${fmtNum(Math.abs(ci.delta))} ${core.esc(it?.unit || '')} × ${fmtMoney(it?.price || 0)})`;
    }).join('<br>');
    return `<div class="tx-item">
      <div style="flex:1;">
        <strong>أمر تغييري #${co.no}</strong> <span class="erp-chip">${core.esc(co.date || '')}</span><br>
        <div style="font-size:12.5px; margin-top:2px;">${core.esc(co.desc || '')}</div>
        <small style="color:var(--muted);">${det}</small>
      </div>
      <div style="text-align:left;">
        <strong class="${coVal >= 0 ? 'amt-in' : 'amt-out'}">${coVal >= 0 ? '+' : '−'}${fmtMoney(Math.abs(coVal))}</strong>
        ${core.isAdmin() ? `<br><button type="button" class="sm secondary" style="margin-top:4px; color:var(--red);" data-ec-delco="${core.esc(co.id)}" data-pid="${core.esc(pid)}">حذف</button>` : ''}
      </div>
    </div>`;
  }).join('');

  return `<div class="card">
    <div class="between" style="margin-bottom:6px;">
      <h3 style="margin:0; font-size:14.5px;">✏️ الأوامر التغييرية</h3>
      <button type="button" class="sm gold" data-ec-modal="addCo" data-pid="${core.esc(pid)}">+ أمر تغييري جديد</button>
    </div>
    <small style="color:var(--muted); display:block; margin-bottom:8px;">أي زيادة أو خصم أو بند مستحدث يُحدّث قيمة العقد والمقايسة والمستخلصات ونسب الإنجاز فوراً.</small>
    ${itemsHtml || '<p style="color:var(--muted); text-align:center;">لا توجد أوامر تغييرية لهذا المشروع.</p>'}
  </div>`;
}

function renderStatementsScreen() {
  const allProjs = core.getProjects();
  if (!allProjs.length) return '<div class="card"><p style="color:var(--muted); text-align:center;">لا توجد مشاريع بعد.</p></div>';
  const pid = ui.stmtPid && allProjs.some((p) => p.id === ui.stmtPid) ? ui.stmtPid : ensureSelectedPid(ui.pid);
  ui.stmtPid = pid;
  return `<div class="erp-shell">
    <div class="card" style="padding:12px;">
      <div class="between" style="margin-bottom:6px;">
        <strong style="color:var(--primary);">🧾 المستخلصات التراكمية للعملاء</strong>
        <button type="button" class="sm gold" data-ec-modal="newStmt" data-pid="${core.esc(pid)}">+ مستخلص جديد</button>
      </div>
      <select data-ec-action="selectStmtProj">
        ${allProjs.map((p) => `<option value="${core.esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${core.esc(p.name)}</option>`).join('')}
      </select>
    </div>
    ${renderProjectStatementsCard(pid)}
  </div>`;
}

function renderProjectStatementsCard(pid) {
  const c = getContract(pid);
  const sts = getProjectStatements(pid);
  if (!sts.length) {
    return `<div class="card">
      <div class="between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:14.5px;">🧾 مستخلصات ${core.esc(projNameById(pid))}</h3>
        <button type="button" class="sm gold" data-ec-modal="newStmt" data-pid="${core.esc(pid)}">+ مستخلص رقم 1</button>
      </div>
      <p style="color:var(--muted); text-align:center; font-size:13px;">لا توجد مستخلصات لهذا المشروع بعد. تأكد من إضافة بنود المقايسة أولاً ثم أنشئ المستخلص رقم 1.</p>
    </div>`;
  }
  const activeSt = sts.find((s) => s.id === ui.stmtId) || sts[sts.length - 1];
  ui.stmtId = activeSt.id;
  const d = calcStatementDue(pid, activeSt);

  const tabs = `<div class="erp-subtabs">${sts.map((s) =>
    `<button type="button" class="erp-tab ${s.id === activeSt.id ? 'active' : ''}" data-ec-stmtid="${core.esc(s.id)}">مستخلص #${s.no}</button>`
  ).join('')}</div>`;

  const rows = d.lines.filter((l) => l.qty > 0 || l.exec > 0).map((l) => `<tr>
    <td class="head" data-l="البند">${core.esc(l.name)}</td>
    <td data-l="الوحدة">${core.esc(l.unit)}</td>
    <td class="r" data-l="كمية العقد">${fmtNum(l.qty)}</td>
    <td class="r" data-l="السعر">${fmtMoney(l.price)}</td>
    <td class="r" data-l="السابق">${fmtNum(l.prevExec)}</td>
    <td class="r" data-l="المستجد">${fmtNum(l.deltaExec)}</td>
    <td class="r" data-l="التراكمي"><strong>${fmtNum(l.exec)}</strong></td>
    <td class="r" data-l="قيمة المنفذ">${fmtMoney(l.value)}</td>
    <td class="r" data-l="الإنجاز">${fmtPct(l.pct)}</td>
  </tr>`).join('');

  const extraLines = d.extras.map((ex) =>
    `<div class="erp-sumline"><span>يُخصم: ${core.esc(ex.label || 'استقطاع إضافي')}</span><strong class="erp-neg">− ${fmtMoney(ex.amount)}</strong></div>`
  ).join('');

  return `${tabs}<div class="card">
    <div class="between" style="flex-wrap:wrap; margin-bottom:6px;">
      <div>
        <h3 style="margin:0; font-size:14.5px;">مستخلص جاري رقم ${activeSt.no} — ${core.esc(projNameById(pid))}</h3>
        <small style="color:var(--muted);">التاريخ: ${core.esc(activeSt.date || '')} • ضمان ${fmtPct(c.retentionPct)} • مقدم ${fmtPct(c.advancePct)}</small>
      </div>
      <div class="row">
        <button type="button" class="sm gold" data-ec-modal="newStmt" data-pid="${core.esc(pid)}">+ جديد</button>
        <button type="button" class="sm secondary" data-ec-printstmt="${core.esc(activeSt.id)}" data-pid="${core.esc(pid)}">🖨️ طباعة / PDF</button>
        ${core.isAdmin() ? `<button type="button" class="sm red" data-ec-delstmt="${core.esc(activeSt.id)}" data-pid="${core.esc(pid)}">حذف</button>` : ''}
      </div>
    </div>
    ${activeSt.note ? `<div style="font-size:12px; color:var(--muted); margin-bottom:6px;">📝 ${core.esc(activeSt.note)}</div>` : ''}
    <div class="erp-tblwrap">
      <table class="erp-tbl">
        <thead><tr><th>البند</th><th>الوحدة</th><th class="r">العقد</th><th class="r">السعر</th><th class="r">سابق</th><th class="r">مستجد</th><th class="r">تراكمي</th><th class="r">القيمة</th><th class="r">إنجاز</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9" style="text-align:center;">لا توجد بنود</td></tr>'}</tbody>
      </table>
    </div>
    <div class="erp-sumbox">
      <div class="erp-sumline"><span>إجمالي الأعمال المنفذة التراكمي</span><strong>${fmtMoney(d.gross)}</strong></div>
      <div class="erp-sumline"><span>الأعمال المستجدة في هذا المستخلص فقط</span><strong style="color:var(--primary);">${fmtMoney(d.currentGrossDelta)}</strong></div>
      ${d.retention > 0 ? `<div class="erp-sumline"><span>يُخصم: حجز الضمان التراكمي (${fmtPct(c.retentionPct)})</span><strong class="erp-neg">− ${fmtMoney(d.retention)}</strong></div>` : ''}
      ${d.advRec > 0 ? `<div class="erp-sumline"><span>يُخصم: استرداد الدفعة المقدمة (${fmtPct(c.advancePct)})</span><strong class="erp-neg">− ${fmtMoney(d.advRec)}</strong></div>` : ''}
      <div class="erp-sumline"><span>صافي الأعمال التراكمي (قبل الاستقطاعات الإضافية)</span><strong>${fmtMoney(d.netBeforeExtras)}</strong></div>
      ${d.prevNetBeforeExtras > 0 ? `<div class="erp-sumline"><span>يُخصم: صافي المعتمد بالمستخلصات السابقة</span><strong class="erp-neg">− ${fmtMoney(d.prevNetBeforeExtras)}</strong></div>` : ''}
      ${extraLines}
      <div class="erp-sumline total"><span>صافي المستحق الصرف في مستخلص #${activeSt.no}</span><strong class="${d.dueNow >= 0 ? 'erp-pos' : 'erp-neg'}">${fmtMoney(d.dueNow)}</strong></div>
      <div style="font-size:11.5px; color:var(--primary); font-weight:700;">${core.esc(core.tafqeet(d.dueNow))}</div>
    </div>
  </div>`;
}

function renderClientsScreen() {
  const projs = core.getProjects().filter((p) => !p.archived || contractsMap.has(p.id));
  if (!projs.length) return '<div class="card"><p style="color:var(--muted); text-align:center;">لا توجد مشاريع بعد.</p></div>';

  let totBalance = 0, totRet = 0, totPaid = 0;
  const cards = projs.map((p) => {
    const c = getContract(p.id);
    const f = getProjectFinancials(p.id);
    if (f.cv <= 0 && f.paid <= 0 && !c.client) return '';
    totBalance = core.round2(totBalance + Math.max(0, f.balance));
    totRet = core.round2(totRet + f.retention);
    totPaid = core.round2(totPaid + f.paid);
    const sched = getRetentionSchedule(p.id);

    return `<div class="card">
      <div class="between" style="flex-wrap:wrap; gap:6px;">
        <div>
          <strong>🤝 ${core.esc(c.client || 'عميل غير مسمى')}</strong> <span class="erp-chip brand">${core.esc(p.name)}</span>
        </div>
        <div class="row">
          <button type="button" class="sm secondary" data-ec-openproj="${core.esc(p.id)}">ملف العقد</button>
          ${core.isAdmin() ? `<button type="button" class="sm green" data-ec-modal="clientPay" data-pid="${core.esc(p.id)}">+ دفعة مستلمة</button>` : ''}
        </div>
      </div>
      <div class="erp-sumbox">
        <div class="erp-sumline"><span>قيمة العقد الحالية</span><strong>${fmtMoney(f.cv)}</strong></div>
        <div class="erp-sumline"><span>أعمال منفذة بالمستخلصات (${fmtPct(f.progress)})</span><strong>${fmtMoney(f.gross)}</strong></div>
        ${f.advTotal > 0 ? `<div class="erp-sumline"><span>الدفعة المقدمة التعاقدية (${fmtPct(c.advancePct)}) / مسترد</span><strong>${fmtMoney(f.advTotal)} / −${fmtMoney(f.advRec)}</strong></div>` : ''}
        ${f.retention > 0 ? `<div class="erp-sumline"><span>حجز ضمان محتجَز (${fmtPct(c.retentionPct)})</span><strong>${fmtMoney(f.retention)}</strong></div>` : ''}
        <div class="erp-sumline"><span>صافي المعتمد بالمستخلصات</span><strong>${fmtMoney(f.certifiedNet)}</strong></div>
        <div class="erp-sumline"><span>إجمالي المقبوض فعلياً (من دفتر v14)</span><strong class="erp-pos">${fmtMoney(f.paid)}</strong></div>
        <div class="erp-sumline total"><span>المتبقي المستحق عند العميل</span><strong style="color:${f.balance > 0 ? 'var(--orange)' : 'var(--green)'};">${fmtMoney(f.balance)}</strong></div>
      </div>
      ${sched.length ? `<div style="margin-top:8px; font-size:12px;"><strong style="color:var(--muted);">مواعيد رد حجز الضمان:</strong>${sched.map((r) => `<div class="erp-sumline" style="font-size:11.5px;"><span>${core.esc(r.label)}</span><strong>${fmtMoney(r.amount)}${r.date ? ' • ' + core.esc(r.date) : ''}</strong></div>`).join('')}</div>` : ''}
      ${f.paidTxs.length ? `<div style="margin-top:8px; font-size:12px;"><strong style="color:var(--muted);">آخر الدفعات المحصّلة:</strong>${f.paidTxs.slice(0, 4).map((t) => `<div class="erp-sumline" style="font-size:11.5px;"><span>${core.esc(t.txDate || '')} • ${core.esc(t.paymentMethod || '')} ${core.esc(t.note || 'وارد')}</span><strong class="erp-pos">${fmtMoney(t.amount)}</strong></div>`).join('')}</div>` : ''}
    </div>`;
  }).filter(Boolean).join('');

  return `<div class="erp-shell">
    <div class="hero-card">
      <div class="hero-label">🤝 ملخص مستحقات العملاء وحجز الضمان</div>
      <div class="hero-grid-3">
        <div class="hero-sub"><small>مستحق عند العملاء</small><strong style="color:#facc15;">${fmtMoney(totBalance)}</strong></div>
        <div class="hero-sub"><small>حجز ضمان محتجز</small><strong>${fmtMoney(totRet)}</strong></div>
        <div class="hero-sub"><small>مقبوض فعلياً</small><strong style="color:#34d399;">${fmtMoney(totPaid)}</strong></div>
      </div>
    </div>
    ${!core.isAdmin() ? '<div class="erp-alert amber"><span class="erp-alert-ic">🔒</span><div>تسجيل الدفعات النقدية الواردة إلى دفتر الشركة مخصص للمدير فقط لضمان تطابق الخزينة.</div></div>' : ''}
    ${cards || '<div class="card"><p style="color:var(--muted); text-align:center;">ابدأ بإضافة بيانات العقد والمقايسة لأي مشروع من شاشة «📑 العقود والمقايسات».</p></div>'}
  </div>`;
}

function renderGuaranteesScreen() {
  const rows = [];
  core.getProjects().forEach((p) => {
    const c = getContract(p.id);
    const cv = getContractValue(p.id);
    c.guarantees.forEach((g) => {
      rows.push({ pid: p.id, pName: p.name, g, amt: core.round2(cv * (Number(g.pct || 0) / 100)), days: daysUntil(g.expiry) });
    });
  });
  rows.sort((a, b) => (a.g.expiry || '9999').localeCompare(b.g.expiry || '9999'));
  const pidDefault = ensureSelectedPid(ui.pid);

  return `<div class="erp-shell">
    <div class="erp-alert amber"><span class="erp-alert-ic">🛡️</span><div>خطابات الضمان البنكية القريبة من الانتهاء (خلال 30 يوماً) تظهر تلقائياً في التنبيهات الذكية لتجديدها أو طلب الإفراج عنها قبل تسييلها.</div></div>
    <div class="card">
      <div class="between" style="margin-bottom:8px;">
        <h3 style="margin:0; font-size:14.5px;">🛡️ كل خطابات الضمان البنكية</h3>
        ${pidDefault ? `<button type="button" class="sm gold" data-ec-modal="addGuar" data-pid="${core.esc(pidDefault)}">+ خطاب جديد</button>` : ''}
      </div>
      ${renderGuaranteesTableHtml(rows)}
    </div>
  </div>`;
}

function renderProjectGuaranteesCard(pid, c) {
  const cv = getContractValue(pid);
  const rows = c.guarantees.map((g) => ({ pid, pName: projNameById(pid), g, amt: core.round2(cv * (Number(g.pct || 0) / 100)), days: daysUntil(g.expiry) }));
  return `<div class="card">
    <div class="between" style="margin-bottom:8px;">
      <h3 style="margin:0; font-size:14.5px;">🛡️ خطابات الضمان — ${core.esc(projNameById(pid))}</h3>
      <button type="button" class="sm gold" data-ec-modal="addGuar" data-pid="${core.esc(pid)}">+ خطاب ضمان</button>
    </div>
    ${renderGuaranteesTableHtml(rows)}
  </div>`;
}

function renderGuaranteesTableHtml(rows) {
  if (!rows.length) return '<p style="color:var(--muted); text-align:center; font-size:13px;">لا توجد خطابات ضمان مسجلة.</p>';
  return `<div class="erp-tblwrap"><table class="erp-tbl">
    <thead><tr><th>المشروع والنوع</th><th>البنك / الرقم</th><th class="r">القيمة</th><th>الانتهاء</th><th>الحالة</th><th>إجراء</th></tr></thead>
    <tbody>${rows.map(({ pid, pName, g, amt, days }) => {
      const chip = g.released
        ? '<span class="erp-chip green">✅ تم الإفراج</span>'
        : (days === null ? '<span class="erp-chip">—</span>'
          : (days < 0 ? '<span class="erp-chip red">انتهى!</span>'
            : (days <= 10 ? `<span class="erp-chip red">متبقي ${days} يوم</span>`
              : (days <= 30 ? `<span class="erp-chip amber">متبقي ${days} يوم</span>` : `<span class="erp-chip green">متبقي ${days} يوم</span>`))));
      return `<tr>
        <td class="head" data-l="المشروع والنوع">${core.esc(pName)}<br><small style="color:var(--muted); font-weight:normal;">${core.esc(g.type || '')}</small></td>
        <td data-l="البنك / الرقم">${core.esc(g.bank || '')}<br><small style="color:var(--muted);">${core.esc(g.no || '')}</small></td>
        <td class="r" data-l="القيمة"><strong>${fmtMoney(amt)}</strong><br><small style="color:var(--muted);">${fmtPct(g.pct)}</small></td>
        <td data-l="الانتهاء">${core.esc(g.expiry || '—')}</td>
        <td data-l="الحالة">${chip}</td>
        <td data-l="إجراء">
          <button type="button" class="sm secondary" data-ec-toggleguar="${core.esc(g.id)}" data-pid="${core.esc(pid)}">${g.released ? 'إعادة كقائم' : 'إفراج'}</button>
          ${core.isAdmin() ? `<button type="button" class="sm red" data-ec-delguar="${core.esc(g.id)}" data-pid="${core.esc(pid)}">×</button>` : ''}
        </td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

/* ============ النوافذ المنبثقة (Modals) ============ */
function openErpModal(title, bodyHtml) {
  const modal = document.getElementById('erpSheetModal');
  const titleEl = document.getElementById('erpSheetTitle');
  const bodyEl = document.getElementById('erpSheetBody');
  if (!modal || !titleEl || !bodyEl) return;
  titleEl.innerText = title;
  bodyEl.innerHTML = bodyHtml;
  modal.classList.remove('hidden');
  core.pushNavState();
}

function closeErpModal() {
  core.closeModal('erpSheetModal');
}

function openContractFormModal(kind, pid, extraId = '') {
  const c = getContract(pid);
  const pName = projNameById(pid);

  if (kind === 'editContract') {
    openErpModal(`تعديل بيانات عقد — ${pName}`, `
      <form data-ec-form="editContract" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field full"><label>اسم العميل / المالك / الجهة</label><input name="client" value="${core.esc(c.client)}" placeholder="مثلاً: اتحاد ملاك برج الزمالك أو هيئة حكومية"></div>
          <div class="erp-field"><label>موقع المشروع</label><input name="location" value="${core.esc(c.location)}" placeholder="مثلاً: الزمالك - القاهرة"></div>
          <div class="erp-field"><label>حالة المشروع</label>
            <select name="status">
              ${['جارٍ التنفيذ', 'في مرحلة التجهيز', 'متوقف مؤقتاً', 'منتهي'].map((st) => `<option ${c.status === st ? 'selected' : ''}>${st}</option>`).join('')}
            </select>
          </div>
          <div class="erp-field"><label>تاريخ البدء</label><input type="date" name="startDate" value="${core.esc(c.startDate)}"></div>
          <div class="erp-field"><label>الدفعة المقدمة % (من 0 إلى 90)</label><input type="number" name="advancePct" min="0" max="90" step="0.5" value="${Number(c.advancePct || 0)}"></div>
          <div class="erp-field"><label>حجز الضمان % (من 0 إلى 25)</label><input type="number" name="retentionPct" min="0" max="25" step="0.5" value="${Number(c.retentionPct || 0)}"></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ بيانات العقد</button>
      </form>`);
  } else if (kind === 'addBoq' || kind === 'editBoq') {
    const it = kind === 'editBoq' ? c.boq.find((b) => b.id === extraId) : null;
    openErpModal(it ? `تعديل بند في المقايسة` : `إضافة بند جديد — ${pName}`, `
      <form data-ec-form="saveBoq" data-pid="${core.esc(pid)}" data-bid="${core.esc(it?.id || '')}">
        <div class="erp-fgrid">
          <div class="erp-field full"><label>وصف البند</label><input name="name" required value="${core.esc(it?.name || '')}" placeholder="مثلاً: دهانات واجهات خارجية جوتن"></div>
          <div class="erp-field"><label>الوحدة</label><input name="unit" required value="${core.esc(it?.unit || 'م²')}" placeholder="م² / م³ / طن / مقطوعية"></div>
          <div class="erp-field"><label>كمية العقد</label><input type="number" name="qty" step="any" min="0.01" required value="${it ? it.qty : ''}"></div>
          <div class="erp-field full"><label>سعر الوحدة (جنيه — سري للإدارة فقط)</label><input type="number" name="price" step="any" min="0" required value="${it ? it.price : ''}"></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ البند ومزامنة الموقع</button>
      </form>`);
  } else if (kind === 'addCo') {
    const eff = getEffectiveBoq(pid);
    openErpModal(`أمر تغييري جديد — ${pName}`, `
      <form data-ec-form="addCo" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field"><label>التاريخ</label><input type="date" name="date" value="${core.esc(core.getLocalDateStr())}" required></div>
          <div class="erp-field"><label>نوع التعديل</label>
            <select name="kind" id="ecCoKind" onchange="document.getElementById('ecCoQtyBox').classList.toggle('hidden', this.value!=='qty'); document.getElementById('ecCoNewBox').classList.toggle('hidden', this.value!=='new');">
              <option value="qty" ${eff.length ? '' : 'disabled'}>زيادة / خصم كمية بند قائم</option>
              <option value="new" ${eff.length ? '' : 'selected'}>إضافة بند مستحدث جديد</option>
            </select>
          </div>
          <div class="erp-field full"><label>سبب / وصف الأمر التغييري</label><input name="desc" required placeholder="مثلاً: زيادة مساحة الواجهة الجانبية بطلب المالك"></div>
          <div id="ecCoQtyBox" class="full ${eff.length ? '' : 'hidden'}">
            <div class="erp-field"><label>البند</label><select name="boqId">${eff.map((b) => `<option value="${core.esc(b.id)}">${core.esc(b.name)} (كمية حالية: ${fmtNum(b.qty)} ${core.esc(b.unit)})</option>`).join('')}</select></div>
            <div class="erp-field"><label>التغيير في الكمية (موجب للزيادة، سالب للخصم)</label><input type="number" name="delta" step="any" placeholder="مثلاً: 150 أو -50"></div>
          </div>
          <div id="ecCoNewBox" class="full ${eff.length ? 'hidden' : ''}">
            <div class="erp-fgrid">
              <div class="erp-field full"><label>اسم البند المستحدث</label><input name="nname" placeholder="مثلاً: عزل سطح بيتومين"></div>
              <div class="erp-field"><label>الوحدة</label><input name="nunit" value="م²"></div>
              <div class="erp-field"><label>الكمية</label><input type="number" name="nqty" step="any"></div>
              <div class="erp-field full"><label>سعر الوحدة (جنيه)</label><input type="number" name="nprice" step="any"></div>
            </div>
          </div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ اعتماد الأمر التغييري</button>
      </form>`);
  } else if (kind === 'newStmt') {
    const eff = getEffectiveBoq(pid);
    if (!eff.length) {
      core.showToast('أضف بنود المقايسة أولاً قبل إنشاء المستخلص', { error: true });
      return;
    }
    const sts = getProjectStatements(pid);
    const last = sts.length ? sts[sts.length - 1] : null;
    const siteQtys = c.approvedSiteQtys || {};
    const nextNo = sts.length + 1;
    const rowsHtml = eff.map((it) => {
      const prevQ = last ? Number(last.qtys?.[it.id] || 0) : 0;
      const siteQ = Number(siteQtys[it.id] || 0);
      const suggestedQ = Math.max(prevQ, siteQ);
      const hasNewSite = siteQ > prevQ;
      return `<div class="tx-item" style="flex-direction:column; align-items:stretch; gap:4px; padding:8px 0;">
        <div class="between">
          <strong style="font-size:13px;">${core.esc(it.name)}</strong>
          <small style="color:var(--muted);">عقد: ${fmtNum(it.qty)} ${core.esc(it.unit)} × ${fmtMoney(it.price)}</small>
        </div>
        <div class="between" style="font-size:11.5px; color:var(--muted);">
          <span>سابق بالمستخلص: ${fmtNum(prevQ)}</span>
          ${hasNewSite ? `<span style="color:var(--green); font-weight:700;">✅ معتمد من الموقع: ${fmtNum(siteQ)}</span>` : ''}
        </div>
        <input type="number" step="any" min="0" name="q_${core.esc(it.id)}" value="${suggestedQ}" data-ec-stmtlive="${core.esc(pid)}" placeholder="الكمية التراكمية حتى اليوم">
      </div>`;
    }).join('');

    openErpModal(`إنشاء مستخلص جاري #${nextNo} — ${pName}`, `
      <form data-ec-form="newStmt" data-pid="${core.esc(pid)}" id="ecStmtForm">
        <div class="erp-fgrid">
          <div class="erp-field"><label>تاريخ المستخلص</label><input type="date" name="date" value="${core.esc(core.getLocalDateStr())}" required></div>
          <div class="erp-field"><label>رقم المستخلص</label><input value="${nextNo}" disabled></div>
          <div class="erp-field full"><label>ملاحظة (اختياري)</label><input name="note" placeholder="مثلاً: مستخلص أعمال شهر نوفمبر"></div>
        </div>
        <div style="margin-top:8px; max-height:240px; overflow-y:auto; padding:0 4px; border:1px solid var(--border); border-radius:12px;">
          ${rowsHtml}
        </div>
        <div style="margin-top:10px; background:var(--bg); padding:9px; border-radius:12px;">
          <div class="between">
            <strong style="font-size:12.5px;">استقطاعات إضافية على هذا المستخلص (اختياري):</strong>
            <button type="button" class="sm secondary" data-ec-addded="${core.esc(pid)}">+ استقطاع</button>
          </div>
          <small style="color:var(--muted); display:block; font-size:11px;">مثل: تأمينات اجتماعية، دمغات هندسية، خصم استشاري، غرامات.</small>
          <div id="ecExtraDedsBox"></div>
        </div>
        <div id="ecStmtLiveBox" class="erp-sumbox"></div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ المستخلص #${nextNo}</button>
      </form>`);
    updateStmtLivePreview(pid);
  } else if (kind === 'clientPay') {
    if (!core.isAdmin()) { core.showToast('تسجيل الدفعات النقدية للمدير فقط', { error: true }); return; }
    const f = getProjectFinancials(pid);
    const sts = getProjectStatements(pid);
    openErpModal(`💰 تسجيل دفعة مستلمة — ${pName}`, `
      <div class="erp-alert green"><span class="erp-alert-ic">✅</span><div>ستُضاف هذه الدفعة تلقائياً كـ <strong>إيراد معتمد (income)</strong> في دفتر المشروع في <code>v14</code> لتتطابق كل الشاشات لحظياً.</div></div>
      <form data-ec-form="clientPay" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field full"><label>المبلغ المستلم (جنيه) — المتبقي عند العميل: ${fmtMoney(f.balance)}</label>
            <div class="amt-wrap">
              <input type="number" id="ecPayAmt" name="amount" min="1" step="any" required value="${f.balance > 0 ? f.balance : ''}">
              <button type="button" class="calc-trigger" onclick="openCalcFor('ecPayAmt')">🧮</button>
            </div>
          </div>
          <div class="erp-field"><label>التاريخ</label><input type="date" name="date" value="${core.esc(core.getLocalDateStr())}" required></div>
          <div class="erp-field"><label>طريقة الاستلام</label>
            <select name="method"><option>تحويل بنكي</option><option>نقداً</option><option>شيك</option><option>إنستا باي</option></select>
          </div>
          <div class="erp-field full"><label>ربط بمستخلص (اختياري)</label>
            <select name="statementId">
              <option value="">دفعة عامة / تحت الحساب / دفعة مقدمة</option>
              ${sts.map((s) => `<option value="${core.esc(s.id)}">مستخلص رقم #${s.no} (${core.esc(s.date || '')})</option>`).join('')}
            </select>
          </div>
          <div class="erp-field full"><label>البيان</label><input name="note" value="دفعة من العميل${c.client ? ' - ' + core.esc(c.client) : ''}" required></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ تسجيل الدفعة في الحسابات</button>
      </form>`);
  } else if (kind === 'addGuar') {
    const projs = core.getProjects();
    openErpModal('🛡️ إضافة خطاب ضمان بنكي', `
      <form data-ec-form="addGuar" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field full"><label>المشروع</label>
            <select name="projectId">${projs.map((p) => `<option value="${core.esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${core.esc(p.name)}</option>`).join('')}</select>
          </div>
          <div class="erp-field full"><label>نوع الخطاب</label>
            <select name="type"><option>خطاب الضمان النهائي</option><option>خطاب ضمان الدفعة المقدمة</option><option>خطاب ضمان ابتدائي (مناقصة)</option></select>
          </div>
          <div class="erp-field"><label>النسبة من العقد %</label><input type="number" name="pct" min="0" max="100" step="0.5" value="5" required></div>
          <div class="erp-field"><label>تاريخ الانتهاء</label><input type="date" name="expiry" required></div>
          <div class="erp-field"><label>البنك المُصدر</label><input name="bank" required placeholder="مثلاً: بنك مصر"></div>
          <div class="erp-field"><label>رقم الخطاب</label><input name="no" required placeholder="LG-0000"></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ خطاب الضمان</button>
      </form>`);
  } else if (kind === 'editPhases') {
    openErpModal(`📊 تحديث مراحل التنفيذ — ${pName}`, `
      <form data-ec-form="editPhases" data-pid="${core.esc(pid)}">
        ${c.phases.map((ph, idx) => `
          <div style="background:var(--bg); padding:8px; border-radius:10px; margin-bottom:8px;">
            <input name="ph_name_${idx}" value="${core.esc(ph.name)}" style="margin-top:0; font-weight:bold;">
            <div class="erp-fgrid" style="margin-top:4px;">
              <div class="erp-field"><label>المخطط %</label><input type="number" name="ph_plan_${idx}" min="0" max="100" value="${Number(ph.planned || 0)}"></div>
              <div class="erp-field"><label>الفعلي %</label><input type="number" name="ph_act_${idx}" min="0" max="100" value="${Number(ph.actual || 0)}"></div>
            </div>
          </div>`).join('')}
        <input type="hidden" name="phCount" value="${c.phases.length}">
        <button type="submit" class="green" style="margin-top:8px;">✅ حفظ نسب المراحل</button>
      </form>`);
  } else if (kind === 'editHandover') {
    const h = c.handover || {};
    openErpModal(`🏁 محضر التسليم والضمان — ${pName}`, `
      <form data-ec-form="editHandover" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field"><label>تاريخ الاستلام الابتدائي الفعلي</label><input type="date" name="initial" value="${core.esc(h.initial || '')}"></div>
          <div class="erp-field"><label>الابتدائي المتوقع</label><input type="date" name="initialExpected" value="${core.esc(h.initialExpected || '')}"></div>
          <div class="erp-field"><label>تاريخ الاستلام النهائي الفعلي</label><input type="date" name="final" value="${core.esc(h.final || '')}"></div>
          <div class="erp-field"><label>النهائي المتوقع</label><input type="date" name="finalExpected" value="${core.esc(h.finalExpected || '')}"></div>
          <div class="erp-field full"><label>ملاحظات محضر الاستلام (كل ملاحظة في سطر مستقل)</label><textarea name="notes">${core.esc((h.notes || []).join('\n'))}</textarea></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ بيانات التسليم</button>
      </form>`);
  }
}

function addExtraDedRow(pid) {
  const box = document.getElementById('ecExtraDedsBox');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'erp-ded-row';
  div.innerHTML = `
    <input type="text" class="ec-ded-lbl" placeholder="البيان (تأمينات / دمغات / استشاري)" style="flex:1.6;">
    <input type="number" class="ec-ded-amt" step="any" min="0" placeholder="المبلغ" style="flex:1;" data-ec-stmtlive="${core.esc(pid)}">
    <button type="button" class="sm red" onclick="this.parentElement.remove(); window.ReviseErpContracts.refreshStmtLive('${core.esc(pid)}');">×</button>`;
  box.appendChild(div);
}

function readExtraDedsFromForm() {
  const rows = [...document.querySelectorAll('#ecExtraDedsBox .erp-ded-row')];
  return rows.map((r) => ({
    label: (r.querySelector('.ec-ded-lbl')?.value || '').trim() || 'استقطاع إضافي',
    amount: Math.max(0, Number(r.querySelector('.ec-ded-amt')?.value || 0))
  })).filter((x) => x.amount > 0);
}

export function updateStmtLivePreview(pid) {
  const box = document.getElementById('ecStmtLiveBox');
  const form = document.getElementById('ecStmtForm');
  if (!box || !form) return;
  const eff = getEffectiveBoq(pid);
  const qtys = {};
  eff.forEach((it) => {
    const inp = form.querySelector(`[name="q_${it.id}"]`);
    const v = parseFloat(inp?.value || '0');
    if (isFinite(v) && v > 0) qtys[it.id] = v;
  });
  const sts = getProjectStatements(pid);
  const tmpStmt = { no: sts.length + 1, qtys, extraDeductions: readExtraDedsFromForm() };
  const d = calcStatementDue(pid, tmpStmt);
  box.innerHTML = `
    <div class="erp-sumline"><span>إجمالي الأعمال التراكمي</span><strong>${fmtMoney(d.gross)}</strong></div>
    <div class="erp-sumline"><span>الأعمال المستجدة هذا المستخلص</span><strong style="color:var(--primary);">${fmtMoney(d.currentGrossDelta)}</strong></div>
    ${d.retention > 0 ? `<div class="erp-sumline"><span>حجز الضمان</span><strong class="erp-neg">− ${fmtMoney(d.retention)}</strong></div>` : ''}
    ${d.advRec > 0 ? `<div class="erp-sumline"><span>استرداد المقدم</span><strong class="erp-neg">− ${fmtMoney(d.advRec)}</strong></div>` : ''}
    ${d.prevNetBeforeExtras > 0 ? `<div class="erp-sumline"><span>المعتمد بالمستخلصات السابقة</span><strong class="erp-neg">− ${fmtMoney(d.prevNetBeforeExtras)}</strong></div>` : ''}
    ${d.extraDeductionsTotal > 0 ? `<div class="erp-sumline"><span>استقطاعات إضافية</span><strong class="erp-neg">− ${fmtMoney(d.extraDeductionsTotal)}</strong></div>` : ''}
    <div class="erp-sumline total"><span>صافي المستحق في هذا المستخلص</span><strong class="${d.dueNow >= 0 ? 'erp-pos' : 'erp-neg'}">${fmtMoney(d.dueNow)}</strong></div>`;
}

/* ============ طباعة / PDF المستخلص الرسمي ============ */
function printStatementOfficial(pid, stmtId) {
  const stmt = statementsList.find((s) => s.id === stmtId);
  if (!stmt) return;
  const c = getContract(pid);
  const d = calcStatementDue(pid, stmt);
  const s = core.getCompanySettings();
  const safeImg = (src) => (src && src.startsWith('data:image/')) ? `<img src="${src}" onerror="this.remove()">` : '';

  const trs = d.lines.filter((l) => l.qty > 0 || l.exec > 0).map((l, idx) => `<tr>
    <td>${idx + 1}</td>
    <td class="pdf-note-cell">${core.esc(l.name)}</td>
    <td>${core.esc(l.unit)}</td>
    <td>${fmtNum(l.qty)}</td>
    <td>${fmtNum(l.price)}</td>
    <td>${fmtNum(l.prevExec)}</td>
    <td>${fmtNum(l.deltaExec)}</td>
    <td><strong>${fmtNum(l.exec)}</strong></td>
    <td><strong>${fmtNum(l.value)}</strong></td>
  </tr>`).join('');

  const extrasRows = d.extras.map((ex) =>
    `<tr><td colspan="7" style="text-align:right;">يُخصم: ${core.esc(ex.label)}</td><td colspan="2" style="color:#dc2626; font-weight:bold;">− ${fmtMoney(ex.amount)}</td></tr>`
  ).join('');

  const html = `<div class="pdf-doc" dir="rtl">
    <div class="pdf-header">
      <div><strong>${core.esc(s.nameAr || 'شركة ريفايس للمقاولات')}</strong><br><small>${core.esc(s.phone || '')}<br>${core.esc(s.email || '')}</small></div>
      ${safeImg(s.logo)}
      <div style="text-align:left;"><strong>${core.esc(s.nameEn || 'Revise Contracting')}</strong><br><small>${core.esc(s.addressAr || '')}</small></div>
    </div>
    <h3 style="text-align:center; color:#1d4ed8; margin:6px 0;">مستخلص جاري رقم (${stmt.no}) — ${core.esc(projNameById(pid))}</h3>
    <p style="text-align:center; font-size:12px; color:#334155; margin:0 0 8px;">العميل: <strong>${core.esc(c.client || '—')}</strong> • التاريخ: <strong>${core.esc(stmt.date || '')}</strong></p>
    <table class="pdf-table">
      <thead><tr><th style="width:5%;">م</th><th style="width:31%;">بيان الأعمال</th><th style="width:8%;">وحدة</th><th style="width:9%;">عقد</th><th style="width:9%;">فئة</th><th style="width:9%;">سابق</th><th style="width:9%;">مستجد</th><th style="width:9%;">تراكمي</th><th style="width:11%;">الإجمالي</th></tr></thead>
      <tbody>
        ${trs}
        <tr style="font-weight:bold; background:#f1f5f9;"><td colspan="7" style="text-align:right;">إجمالي قيمة الأعمال المنفذة التراكمي</td><td colspan="2">${fmtMoney(d.gross)}</td></tr>
        ${d.retention > 0 ? `<tr><td colspan="7" style="text-align:right;">يُخصم: حجز ضمان (${fmtPct(c.retentionPct)})</td><td colspan="2" style="color:#dc2626;">− ${fmtMoney(d.retention)}</td></tr>` : ''}
        ${d.advRec > 0 ? `<tr><td colspan="7" style="text-align:right;">يُخصم: استرداد دفعة مقدمة (${fmtPct(c.advancePct)})</td><td colspan="2" style="color:#dc2626;">− ${fmtMoney(d.advRec)}</td></tr>` : ''}
        ${d.prevNetBeforeExtras > 0 ? `<tr><td colspan="7" style="text-align:right;">يُخصم: صافي المعتمد بالمستخلصات السابقة</td><td colspan="2" style="color:#dc2626;">− ${fmtMoney(d.prevNetBeforeExtras)}</td></tr>` : ''}
        ${extrasRows}
        <tr style="font-weight:bold;"><td colspan="7" style="text-align:right;">صافي المستحق الصرف في مستخلص رقم (${stmt.no})</td><td colspan="2" style="background:#dcfce7; color:#166534; font-size:13px;">${fmtMoney(d.dueNow)}</td></tr>
        <tr><td colspan="9" style="font-weight:bold; color:#1d4ed8;">${core.esc(core.tafqeet(d.dueNow))}</td></tr>
      </tbody>
    </table>
    ${(s.showStamp || s.showSignature) ? `<div class="pdf-footer">
      ${s.showSignature ? `<div><small>التوقيع</small>${safeImg(s.signature) || '<br>________'}</div>` : ''}
      ${s.showStamp ? `<div><small>ختم الشركة</small>${safeImg(s.stamp) || '<br>________'}</div>` : ''}
    </div>` : ''}
  </div>`;

  const pa = document.getElementById('printArea');
  if (!pa) return;
  pa.innerHTML = html;
  pa.classList.remove('hidden');
  setTimeout(() => { window.print(); pa.classList.add('hidden'); pa.innerHTML = ''; }, 150);
}

/* ============ معالجة الأحداث والنماذج ============ */
function bindEvents() {
  document.addEventListener('click', async (e) => {
    if (!core || !core.canAccessErp()) return;

    const sub = e.target.closest('[data-ec-subtab]');
    if (sub) { ui.subTab = sub.dataset.ecSubtab; core.refreshErpView(); return; }

    const stBtn = e.target.closest('[data-ec-stmtid]');
    if (stBtn) { ui.stmtId = stBtn.dataset.ecStmtid; core.refreshErpView(); return; }

    const openProj = e.target.closest('[data-ec-openproj]');
    if (openProj) { core.openErpView('contracts', { projectId: openProj.dataset.ecOpenproj, subTab: 'over' }); return; }

    const mod = e.target.closest('[data-ec-modal]');
    if (mod) { openContractFormModal(mod.dataset.ecModal, mod.dataset.pid, mod.dataset.bid || ''); return; }

    const addDed = e.target.closest('[data-ec-addded]');
    if (addDed) { addExtraDedRow(addDed.dataset.ecAddded); return; }

    const prBtn = e.target.closest('[data-ec-printstmt]');
    if (prBtn) { printStatementOfficial(prBtn.dataset.pid, prBtn.dataset.ecPrintstmt); return; }

    const delBoq = e.target.closest('[data-ec-delboq]');
    if (delBoq) {
      const pid = delBoq.dataset.pid, bid = delBoq.dataset.ecDelboq;
      if (!confirm('حذف هذا البند من المقايسة؟')) return;
      const c = getContract(pid);
      c.boq = c.boq.filter((b) => b.id !== bid);
      await core.withBusy(delBoq, '...', async () => {
        await saveContractDoc(pid, c, `حذف بند من مقايسة ${projNameById(pid)}`);
        core.showToast('تم حذف البند ومزامنة الموقع');
      });
      return;
    }

    const delCo = e.target.closest('[data-ec-delco]');
    if (delCo && core.isAdmin()) {
      const pid = delCo.dataset.pid, cid = delCo.dataset.ecDelco;
      if (!confirm('حذف هذا الأمر التغييري؟ سيتعدل إجمالي العقد تلقائياً.')) return;
      const c = getContract(pid);
      c.changeOrders = c.changeOrders.filter((x) => x.id !== cid);
      await core.withBusy(delCo, '...', async () => {
        await saveContractDoc(pid, c, `حذف أمر تغييري من ${projNameById(pid)}`);
        core.showToast('تم حذف الأمر التغييري');
      });
      return;
    }

    const delStmt = e.target.closest('[data-ec-delstmt]');
    if (delStmt && core.isAdmin()) {
      const sid = delStmt.dataset.ecDelstmt, pid = delStmt.dataset.pid;
      if (!confirm('حذف هذا المستخلص نهائياً؟ (لن يحذف أي دفعة نقدية مسجلة في v14)')) return;
      await core.withBusy(delStmt, '...', async () => {
        const { doc, writeBatch } = core.fs;
        const beforeObj = statementsList.find((x) => x.id === sid);
        const batch = writeBatch(core.db);
        batch.delete(doc(core.db, 'project_statements', sid));
        core.addAuditToBatch(batch, 'delete', 'project_statements', sid, beforeObj, null, `حذف مستخلص #${beforeObj?.no || ''} (${projNameById(pid)})`);
        await batch.commit();
        ui.stmtId = null;
        core.showToast('تم حذف المستخلص');
      });
      return;
    }

    const togG = e.target.closest('[data-ec-toggleguar]');
    if (togG) {
      const pid = togG.dataset.pid, gid = togG.dataset.ecToggleguar;
      const c = getContract(pid);
      c.guarantees = c.guarantees.map((g) => g.id === gid ? { ...g, released: !g.released } : g);
      await core.withBusy(togG, '...', async () => {
        await saveContractDoc(pid, c, `تحديث حالة خطاب ضمان في ${projNameById(pid)}`);
        core.showToast('تم تحديث حالة خطاب الضمان');
      });
      return;
    }

    const delG = e.target.closest('[data-ec-delguar]');
    if (delG && core.isAdmin()) {
      const pid = delG.dataset.pid, gid = delG.dataset.ecDelguar;
      if (!confirm('حذف خطاب الضمان؟')) return;
      const c = getContract(pid);
      c.guarantees = c.guarantees.filter((g) => g.id !== gid);
      await core.withBusy(delG, '...', async () => {
        await saveContractDoc(pid, c, `حذف خطاب ضمان من ${projNameById(pid)}`);
        core.showToast('تم حذف الخطاب');
      });
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-ec-action="selectProj"]')) {
      ui.pid = e.target.value; ui.stmtId = null; core.refreshErpView();
    } else if (e.target.matches('[data-ec-action="selectStmtProj"]')) {
      ui.stmtPid = e.target.value; ui.stmtId = null; core.refreshErpView();
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.matches('[data-ec-stmtlive]')) {
      updateStmtLivePreview(e.target.dataset.ecStmtlive);
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-ec-form]');
    if (!form || !core || !core.canAccessErp()) return;
    e.preventDefault();
    const kind = form.dataset.ecForm;
    const pid = form.dataset.pid;
    const fd = new FormData(form);
    const btn = form.querySelector('button[type="submit"]');

    await core.withBusy(btn, 'جاري الحفظ...', async () => {
      if (kind === 'editContract') {
        const c = getContract(pid);
        c.client = String(fd.get('client') || '').trim();
        c.location = String(fd.get('location') || '').trim();
        c.status = String(fd.get('status') || 'جارٍ التنفيذ');
        c.startDate = String(fd.get('startDate') || '');
        c.advancePct = Math.max(0, Math.min(90, Number(fd.get('advancePct') || 0)));
        c.retentionPct = Math.max(0, Math.min(25, Number(fd.get('retentionPct') || 0)));
        await saveContractDoc(pid, c, `تحديث بيانات عقد ${projNameById(pid)}`);
        closeErpModal();
        core.showToast('✅ تم حفظ بيانات العقد');
      } else if (kind === 'saveBoq') {
        const c = getContract(pid);
        const bid = form.dataset.bid;
        const item = {
          id: bid || genId('boq'),
          name: String(fd.get('name') || '').trim(),
          unit: String(fd.get('unit') || 'مقطوعية').trim(),
          qty: core.round2(Number(fd.get('qty') || 0)),
          price: core.round2(Number(fd.get('price') || 0))
        };
        if (!item.name || item.qty <= 0) throw new Error('أدخل اسم البند وكمية أكبر من صفر');
        if (bid) c.boq = c.boq.map((b) => b.id === bid ? item : b);
        else c.boq.push(item);
        await saveContractDoc(pid, c, `${bid ? 'تعديل' : 'إضافة'} بند مقايسة: ${item.name}`);
        closeErpModal();
        core.showToast('✅ تم حفظ البند ومزامنته مع الموقع (بدون سعر)');
      } else if (kind === 'addCo') {
        const c = getContract(pid);
        const coKind = String(fd.get('kind') || 'qty');
        const desc = String(fd.get('desc') || '').trim();
        const date = String(fd.get('date') || core.getLocalDateStr());
        let items = [];
        if (coKind === 'new') {
          const nname = String(fd.get('nname') || '').trim();
          const nunit = String(fd.get('nunit') || 'مقطوعية').trim();
          const nqty = core.round2(Number(fd.get('nqty') || 0));
          const nprice = core.round2(Number(fd.get('nprice') || 0));
          if (!nname || nqty <= 0) throw new Error('أدخل اسم البند المستحدث وكميته');
          items = [{ newItem: { id: genId('boq'), name: nname, unit: nunit, qty: nqty, price: nprice }, delta: nqty }];
        } else {
          const boqId = String(fd.get('boqId') || '');
          const delta = core.round2(Number(fd.get('delta') || 0));
          if (!boqId || delta === 0) throw new Error('أدخل التغيير في الكمية (لا يساوي صفراً)');
          items = [{ boqId, delta }];
        }
        const no = c.changeOrders.length + 1;
        c.changeOrders.push({ id: genId('co'), no, date, desc, items });
        await saveContractDoc(pid, c, `أمر تغييري #${no} في ${projNameById(pid)}: ${desc}`);
        closeErpModal();
        core.showToast(`✅ تم اعتماد الأمر التغييري #${no}`);
      } else if (kind === 'newStmt') {
        const eff = getEffectiveBoq(pid);
        const qtys = {};
        eff.forEach((it) => {
          const v = parseFloat(fd.get(`q_${it.id}`) || '0');
          if (isFinite(v) && v > 0) qtys[it.id] = core.round2(v);
        });
        const sts = getProjectStatements(pid);
        const no = sts.length + 1;
        const date = String(fd.get('date') || core.getLocalDateStr());
        const note = String(fd.get('note') || '').trim();
        const extraDeductions = readExtraDedsFromForm();
        const { collection, doc, writeBatch, serverTimestamp } = core.fs;
        const stRef = doc(collection(core.db, 'project_statements'));
        const payload = {
          projectId: pid,
          projectName: projNameById(pid),
          no,
          date,
          qtys,
          extraDeductions,
          note,
          createdBy: core.getUser().uid,
          createdByName: core.getUserName(),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };
        const c = getContract(pid);
        // تحديث الكميات المعتمدة بالموقع لتعكس على الأقل ما دخل بالمستخلص
        const nextApproved = { ...(c.approvedSiteQtys || {}) };
        Object.entries(qtys).forEach(([bid, q]) => {
          nextApproved[bid] = Math.max(Number(nextApproved[bid] || 0), Number(q || 0));
        });
        c.approvedSiteQtys = nextApproved;

        const batch = writeBatch(core.db);
        batch.set(stRef, payload);
        batch.set(doc(core.db, 'project_contracts', pid), { ...c, updatedBy: core.getUser().uid, updatedByName: core.getUserName(), updatedAt: serverTimestamp() });
        batch.set(doc(core.db, 'project_site_boq', pid), buildSiteBoqPayload(pid, c));
        if (core.isAdmin()) {
          core.addAuditToBatch(batch, 'create', 'project_statements', stRef.id, null, payload, `إنشاء مستخلص #${no} — ${projNameById(pid)}`);
        }
        await batch.commit();
        ui.stmtId = stRef.id;
        closeErpModal();
        core.showToast(`✅ تم حفظ المستخلص رقم #${no}`);
      } else if (kind === 'clientPay') {
        if (!core.isAdmin()) throw new Error('تسجيل الدفعات النقدية للمدير فقط');
        const amount = core.sanitizeAmount(fd.get('amount'), false);
        if (amount <= 0) throw new Error('أدخل مبلغاً أكبر من صفر');
        const txDate = String(fd.get('date') || core.getLocalDateStr());
        const paymentMethod = String(fd.get('method') || 'تحويل بنكي');
        const statementId = String(fd.get('statementId') || '') || null;
        const note = String(fd.get('note') || '').trim() || `دفعة من العميل (${paymentMethod})`;
        const { collection, doc, writeBatch, serverTimestamp } = core.fs;
        const txRef = doc(collection(core.db, 'transactions'));
        const payload = {
          type: 'in',
          category: 'income',
          paymentMethod,
          ...(statementId ? { statementId } : {}),
          projectId: pid,
          project: projNameById(pid),
          accountId: null,
          accountName: '',
          workerId: null,
          workerName: '',
          txDate,
          amount,
          note: `${note} (${paymentMethod})`,
          deleted: false,
          status: 'approved',
          createdBy: core.getUser().uid,
          createdByName: core.getUserName(),
          createdByRole: core.getUserRole(),
          clientTs: Date.now(),
          receiptId: null,
          hasReceipt: false,
          createdAt: serverTimestamp()
        };
        const batch = writeBatch(core.db);
        batch.set(txRef, payload);
        core.addAuditToBatch(batch, 'create', 'transactions', txRef.id, null, payload, `تحصيل دفعة عميل (${projNameById(pid)}): ${fmtMoney(amount)}`);
        await batch.commit();
        closeErpModal();
        core.showToast(`✅ تم تسجيل دفعة ${fmtMoney(amount)} في دفتر المشروع`);
      } else if (kind === 'addGuar') {
        const targetPid = String(fd.get('projectId') || pid);
        const c = getContract(targetPid);
        c.guarantees.push({
          id: genId('lg'),
          type: String(fd.get('type') || 'خطاب الضمان النهائي'),
          pct: Number(fd.get('pct') || 0),
          bank: String(fd.get('bank') || '').trim(),
          no: String(fd.get('no') || '').trim(),
          expiry: String(fd.get('expiry') || ''),
          released: false
        });
        await saveContractDoc(targetPid, c, `إضافة خطاب ضمان لـ ${projNameById(targetPid)}`);
        closeErpModal();
        core.showToast('✅ تم حفظ خطاب الضمان');
      } else if (kind === 'editPhases') {
        const c = getContract(pid);
        const count = Number(fd.get('phCount') || 0);
        const nextPh = [];
        for (let i = 0; i < count; i++) {
          nextPh.push({
            id: c.phases[i]?.id || genId('ph'),
            name: String(fd.get(`ph_name_${i}`) || `مرحلة ${i + 1}`).trim(),
            planned: Math.max(0, Math.min(100, Number(fd.get(`ph_plan_${i}`) || 0))),
            actual: Math.max(0, Math.min(100, Number(fd.get(`ph_act_${i}`) || 0)))
          });
        }
        c.phases = nextPh;
        await saveContractDoc(pid, c, `تحديث نسب مراحل ${projNameById(pid)}`);
        closeErpModal();
        core.showToast('✅ تم تحديث مراحل المشروع');
      } else if (kind === 'editHandover') {
        const c = getContract(pid);
        const rawNotes = String(fd.get('notes') || '').split('\n').map((s) => s.trim()).filter(Boolean);
        c.handover = {
          initial: String(fd.get('initial') || ''),
          initialExpected: String(fd.get('initialExpected') || ''),
          final: String(fd.get('final') || ''),
          finalExpected: String(fd.get('finalExpected') || ''),
          notes: rawNotes
        };
        await saveContractDoc(pid, c, `تحديث محضر تسليم ${projNameById(pid)}`);
        closeErpModal();
        core.showToast('✅ تم حفظ بيانات التسليم');
      }
    });
  });
}

let eventsBound = false;

export function init(reviseCore) {
  core = reviseCore;
  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }
  if (!core.canAccessErp()) return api;
  if (initialized) return api;
  initialized = true;

  const { collection, onSnapshot } = core.fs;
  const onErr = (err) => {
    core.logClientError('erp-contracts', err);
    core.showToast(core.friendlyError(err), { error: true });
  };

  unsubs.push(onSnapshot(collection(core.db, 'project_contracts'), (snap) => {
    const next = new Map();
    snap.docs.forEach((d) => next.set(d.id, { id: d.id, ...d.data() }));
    contractsMap = next;
    core.onErpDataChanged();
  }, onErr));

  unsubs.push(onSnapshot(collection(core.db, 'project_statements'), (snap) => {
    statementsList = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    core.onErpDataChanged();
  }, onErr));

  return api;
}

export function dispose() {
  unsubs.forEach((u) => { try { u && u(); } catch (e) {} });
  unsubs = [];
  initialized = false;
  contractsMap = new Map();
  statementsList = [];
}

const api = {
  COST_GROUPS,
  init,
  dispose,
  renderView,
  getContract,
  getAllContractsMap,
  getAllStatements,
  getEffectiveBoq,
  getBaseContractValue,
  getChangeOrdersTotal,
  getContractValue,
  getProjectStatements,
  calcStatementRaw,
  calcStatementDue,
  getProjectFinancials,
  getRetentionSchedule,
  buildSiteBoqPayload,
  saveContractDoc,
  refreshStmtLive: updateStmtLivePreview
};

window.ReviseErpContracts = api;
export default api;

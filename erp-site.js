// ============================================================
// Revise v15.0 — erp-site.js
// الميزانية التقديرية مقابل الفعلي (لحظياً من v14)
// + التنبيهات الذكية الحقيقية 100%
// + كميات التنفيذ بالموقع بدون أسعار بيع + طلبات الكميات المعلّقة للاعتماد
// + التقرير اليومي للموقع (مربوط تلقائياً بعدد الحاضرين الفعلي من v14)
// ============================================================

export const COST_GROUPS = ['خامات', 'عمالة', 'مقاولين باطن', 'معدات', 'مصاريف موقع'];

let core = null;
let unsubs = [];
let initialized = false;
let siteBoqMap = new Map();
let qtyRequests = [];
let dailyReports = [];
let alertsExpanded = true;

const ui = {
  pid: null,
  activeView: null
};

const fmtNum = (n) => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
};
const fmtMoney = (n) => `${fmtNum(n)} ج`;
const fmtPct = (n) => `${(Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-US')}%`;

function daysBetween(isoA, isoB) {
  if (!isoA || !isoB) return null;
  const a = new Date(isoA + 'T00:00:00').getTime();
  const b = new Date(isoB + 'T00:00:00').getTime();
  if (!isFinite(a) || !isFinite(b)) return null;
  return Math.round((a - b) / 86400000);
}

function projNameById(pid) {
  return core.getProjects().find((p) => p.id === pid)?.name || 'مشروع';
}

function getAllowedProjectsList() {
  return core.canAccessErp()
    ? core.getProjects().filter((p) => !p.archived)
    : core.getVisibleProjects().filter((p) => !p.archived);
}

function ensureSelectedPid(preferredPid = null) {
  const list = getAllowedProjectsList();
  if (preferredPid && list.some((p) => p.id === preferredPid)) {
    ui.pid = preferredPid;
    return ui.pid;
  }
  if (ui.pid && list.some((p) => p.id === ui.pid)) return ui.pid;
  ui.pid = list[0]?.id || null;
  return ui.pid;
}

/* ============ 1. تصنيف التكلفة التلقائي وحساب الصرف الفعلي لحظياً من v14 ============ */
export function resolveCostGroup(tx) {
  if (!tx) return 'مصاريف موقع';
  if (tx.costGroup && COST_GROUPS.includes(tx.costGroup)) return tx.costGroup;
  const c = tx.category || 'general';
  if (c === 'material_purchase') return 'خامات';
  if (c === 'advance' || c === 'daily' || c === 'overtime' || c === 'salary') {
    const w = core.getUsers().find((u) => u.id === tx.workerId);
    if (!w || w.role === 'worker') return 'عمالة';
    return 'مصاريف موقع';
  }
  if (c === 'meters' || c === 'lump_sum') return 'مقاولين باطن';
  return 'مصاريف موقع';
}

export function computeProjectActualCosts(pid) {
  const byGroup = {};
  COST_GROUPS.forEach((g) => { byGroup[g] = 0; });
  let total = 0;
  const txs = core.getAllTxs().filter((t) => t.projectId === pid && core.isProjectCashExpense(t));
  txs.forEach((t) => {
    const g = resolveCostGroup(t);
    const a = Number(t.amount || 0);
    byGroup[g] = core.round2((byGroup[g] || 0) + a);
    total = core.round2(total + a);
  });
  return { byGroup, total, count: txs.length };
}

export function countAutoAttendance(pid, txDate) {
  const uids = new Set();
  core.getAllTxs().forEach((t) => {
    if (t.deleted === true || t.status === 'rejected') return;
    if (t.projectId !== pid || t.txDate !== txDate) return;
    if (t.isAttendance === true || t.category === 'daily' || t.category === 'attendance') {
      if (t.workerId) uids.add(t.workerId);
    }
  });
  return uids.size;
}

/* ============ 2. محرك التنبيهات الذكية الحقيقية 100% (صفر بيانات وهمية) ============ */
export function getPendingQtyRequests() {
  return qtyRequests.filter((q) => q.status === 'pending');
}

export function computeSmartAlerts() {
  if (!core || !core.canAccessErp()) return [];
  const today = core.getLocalDateStr();
  const alerts = [];
  const ec = window.ReviseErpContracts;

  // 1) طلبات كميات معلّقة من الموقع
  const pendQty = getPendingQtyRequests();
  if (pendQty.length > 0) {
    alerts.push({
      lvl: 'amber',
      action: 'site_quantities',
      txt: `يوجد ${pendQty.length} طلب تحديث كميات منفذة من مهندسي المواقع بانتظار اعتمادك.`
    });
  }

  // 2) عمليات مالية معلّقة منذ 3 أيام أو أكثر
  const oldPendTxs = core.getAllTxs().filter((t) => {
    if (t.deleted === true || t.status !== 'pending' || !t.txDate) return false;
    const d = daysBetween(today, t.txDate);
    return d !== null && d >= 3;
  });
  if (oldPendTxs.length > 0) {
    const sumAmt = core.round2(oldPendTxs.reduce((s, t) => s + Number(t.amount || 0), 0));
    alerts.push({
      lvl: 'amber',
      action: 'approvals_home',
      txt: `يوجد ${oldPendTxs.length} حركة مالية معلّقة منذ 3 أيام أو أكثر بإجمالي ${fmtMoney(sumAmt)}.`
    });
  }

  // 3) عُهد سالبة (موظفون دفعوا من جيبهم ولم يُسدد لهم الفرق)
  const custList = core.getCustodyMapByProject ? core.getCustodyMapByProject() : [];
  custList.filter((e) => e.rem < 0).forEach((e) => {
    const uName = core.getUsers().find((u) => u.id === e.uid)?.name || 'موظف';
    const pName = projNameById(e.pid);
    alerts.push({
      lvl: 'red',
      action: 'custody_home',
      txt: `فرق عُهدة سالب لـ ${uName} في ${pName}: دفع من جيبه ${fmtMoney(Math.abs(e.rem))} بانتظار التسوية.`
    });
  });

  // 4) تنبيهات العقود والضمانات والميزانية والمستخلصات (إن كانت erp-contracts محملة)
  if (ec) {
    core.getProjects().filter((p) => !p.archived).forEach((p) => {
      const c = ec.getContract(p.id);
      const f = ec.getProjectFinancials(p.id);

      // خطابات ضمان تنتهي خلال 30 يوماً
      (c.guarantees || []).filter((g) => !g.released && g.expiry).forEach((g) => {
        const d = daysBetween(g.expiry, today);
        if (d !== null && d <= 30) {
          alerts.push({
            lvl: d <= 10 ? 'red' : 'amber',
            action: 'guarantees',
            txt: `${g.type || 'خطاب ضمان'} — ${p.name} (${g.bank || ''}): ${d < 0 ? 'انتهى منذ ' + Math.abs(d) + ' يوم!' : (d === 0 ? 'ينتهي اليوم!' : 'ينتهي بعد ' + d + ' يوم (' + g.expiry + ')')}.`
          });
        }
      });

      // تجاوز الصرف الفعلي لنسبة الإنجاز
      if (f.budget > 0 && f.cv > 0) {
        const diff = f.spentPct - f.progress;
        if (diff > 8) {
          alerts.push({
            lvl: 'red',
            action: 'budget',
            pid: p.id,
            txt: `تحذير ميزانية (${p.name}): نسبة الصرف ${fmtPct(f.spentPct)} تجاوزت نسبة الإنجاز ${fmtPct(f.progress)} بفارق ${fmtPct(diff)} — راجع التكاليف فوراً.`
          });
        } else if (diff > 3) {
          alerts.push({
            lvl: 'amber',
            action: 'budget',
            pid: p.id,
            txt: `مراقبة ميزانية (${p.name}): نسبة الصرف ${fmtPct(f.spentPct)} أعلى من الإنجاز ${fmtPct(f.progress)} بفارق ${fmtPct(diff)}.`
          });
        }
      }

      // مستخلص متأخر التحصيل > 14 يوماً
      if (f.last && f.last.date && f.balance > 0) {
        const age = daysBetween(today, f.last.date);
        if (age !== null && age >= 14) {
          alerts.push({
            lvl: 'amber',
            action: 'clients',
            txt: `مستخلص متأخر التحصيل (${p.name}): مستخلص #${f.last.no} صدر منذ ${age} يوم والمتبقي عند العميل ${fmtMoney(f.balance)}.`
          });
        }
      }

      // اقتراب الاستلام النهائي مع وجود حجز ضمان
      const h = c.handover || {};
      if (h.finalExpected && !h.final && f.retention > 0) {
        const d = daysBetween(h.finalExpected, today);
        if (d !== null && d >= 0 && d <= 30) {
          alerts.push({
            lvl: 'amber',
            action: 'contracts',
            pid: p.id,
            txt: `استلام نهائي قريب (${p.name}) في ${h.finalExpected} — بعده يُستحق رد حجز ضمان ${fmtMoney(f.retention)}.`
          });
        }
      }
    });
  }

  return alerts;
}

export function renderHomeAlertsCard() {
  const box = document.getElementById('erpSmartAlertsBox');
  if (!box) return;
  if (!core || !core.canAccessErp()) {
    box.classList.add('hidden');
    return;
  }
  const alerts = computeSmartAlerts();
  if (!alerts.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="card" style="border-right:4px solid var(--red); margin-bottom:12px;">
      <div class="between" style="cursor:pointer;" data-es-togglealerts="1">
        <h3 style="margin:0; font-size:14.5px;">🚨 تنبيهات ذكية <span class="badge">${alerts.length}</span></h3>
        <span style="font-size:12px; color:var(--muted);">${alertsExpanded ? '▼' : '◀'}</span>
      </div>
      <div class="${alertsExpanded ? '' : 'hidden'}" style="margin-top:8px;">
        ${alerts.slice(0, 7).map((a) => `
          <div class="erp-alert ${a.lvl} clickable" data-es-alertgo="${core.esc(a.action || '')}" data-pid="${core.esc(a.pid || '')}">
            <span class="erp-alert-ic">${a.lvl === 'red' ? '🔴' : '⚠️'}</span>
            <div>${core.esc(a.txt)}</div>
          </div>`).join('')}
      </div>
    </div>`;
}

/* ============ 3. شاشات الموقع والميزانية والتقرير اليومي ============ */
export function renderView(viewName, opts = {}) {
  ui.activeView = viewName;
  if (opts.projectId) ui.pid = opts.projectId;
  if (viewName === 'budget') return renderBudgetScreen();
  if (viewName === 'site_quantities') return renderSiteQuantitiesScreen();
  if (viewName === 'daily_reports') return renderDailyReportsScreen();
  return renderSiteQuantitiesScreen();
}

/* --- شاشة الميزانية التقديرية مقابل الصرف الفعلي (للمدير وERP فقط) --- */
function renderBudgetScreen() {
  if (!core.canAccessErp()) {
    return '<div class="card"><p style="color:var(--red); text-align:center;">🔒 شاشة الميزانية والربحية للمدير والمحاسب الموثوق فقط.</p></div>';
  }
  const ec = window.ReviseErpContracts;
  const projs = core.getProjects().filter((p) => !p.archived);
  if (!projs.length) return '<div class="card"><p style="color:var(--muted); text-align:center;">لا توجد مشاريع نشطة.</p></div>';

  let grandGross = 0, grandCosts = 0;
  const cards = projs.map((p) => {
    const c = ec ? ec.getContract(p.id) : { budget: {} };
    const f = ec ? ec.getProjectFinancials(p.id) : { cv: 0, gross: 0, progress: 0 };
    const act = computeProjectActualCosts(p.id);
    const budgetTot = core.round2(COST_GROUPS.reduce((s, g) => s + Number(c.budget?.[g] || 0), 0));
    const spentPct = budgetTot > 0 ? (act.total / budgetTot) * 100 : 0;
    const margin = core.round2((f.gross || 0) - act.total);
    grandGross = core.round2(grandGross + (f.gross || 0));
    grandCosts = core.round2(grandCosts + act.total);
    const diff = spentPct - (f.progress || 0);
    const barCls = diff > 8 ? 'red' : (diff > 3 ? 'amber' : '');
    const unpaidCust = core.getProjectUnpaidCustodyDiff ? core.getProjectUnpaidCustodyDiff(p.id) : 0;

    const rows = COST_GROUPS.map((g) => {
      const bVal = Number(c.budget?.[g] || 0);
      const aVal = Number(act.byGroup[g] || 0);
      const gPct = bVal > 0 ? (aVal / bVal) * 100 : (aVal > 0 ? 100 : 0);
      const gDiff = bVal > 0 ? (gPct - (f.progress || 0)) : 0;
      const chip = bVal <= 0
        ? '<span class="erp-chip">بلا ميزانية</span>'
        : (gDiff > 8 ? '<span class="erp-chip red">تجاوز واضح</span>'
          : (gDiff > 3 ? '<span class="erp-chip amber">أعلى من الإنجاز</span>' : '<span class="erp-chip green">في المعدل</span>'));
      return `<tr>
        <td class="head" data-l="بند التكلفة">${g}</td>
        <td class="r" data-l="الميزانية">${fmtMoney(bVal)}</td>
        <td class="r" data-l="الفعلي (لحظي)"><strong>${fmtMoney(aVal)}</strong></td>
        <td data-l="نسبة الصرف">
          <div class="row" style="flex-wrap:nowrap; gap:6px;">
            <div class="erp-bar" style="flex:1; min-width:60px;"><i class="${gDiff > 8 ? 'red' : (gDiff > 3 ? 'amber' : '')}" style="width:${Math.min(100, gPct)}%"></i></div>
            <strong style="font-size:11.5px;">${fmtPct(gPct)}</strong>
          </div>
        </td>
        <td data-l="الحالة">${chip}</td>
        <td class="r" data-l="المتبقي">${bVal > 0 ? fmtMoney(bVal - aVal) : '—'}</td>
      </tr>`;
    }).join('');

    return `<div class="card">
      <div class="between" style="flex-wrap:wrap; margin-bottom:6px;">
        <div>
          <strong style="font-size:15px;">📂 ${core.esc(p.name)}</strong>
          <span class="erp-chip brand">إنجاز ${fmtPct(f.progress || 0)}</span>
        </div>
        <button type="button" class="sm gold" data-es-modal="editBudget" data-pid="${core.esc(p.id)}">✏️ ضبط الميزانية</button>
      </div>
      <div class="erp-alert ${barCls || 'green'}">
        <span class="erp-alert-ic">${barCls === 'red' ? '🔴' : (barCls === 'amber' ? '⚠️' : '✅')}</span>
        <div>الصرف الفعلي من دفتر <code>v14</code>: <strong>${fmtMoney(act.total)}</strong> (${budgetTot > 0 ? fmtPct(spentPct) + ' من الميزانية' : 'لم تُحدد ميزانية بعد'}) مقابل إنجاز <strong>${fmtPct(f.progress || 0)}</strong>.</div>
      </div>
      <div class="erp-barwrap">
        <div class="erp-bar"><i class="${barCls}" style="width:${Math.min(100, spentPct)}%"></i></div>
        ${f.cv > 0 ? `<div class="erp-barmark" style="inset-inline-start:${Math.min(100, f.progress || 0)}%"></div>` : ''}
      </div>
      <div class="erp-tblwrap">
        <table class="erp-tbl">
          <thead><tr><th>بند التكلفة</th><th class="r">الميزانية</th><th class="r">الفعلي</th><th>الصرف</th><th>الحالة</th><th class="r">المتبقي</th></tr></thead>
          <tbody>${rows}</tbody>
          <tfoot><tr><td>الإجمالي</td><td class="r">${fmtMoney(budgetTot)}</td><td class="r">${fmtMoney(act.total)}</td><td>${fmtPct(spentPct)}</td><td></td><td class="r">${budgetTot > 0 ? fmtMoney(budgetTot - act.total) : '—'}</td></tr></tfoot>
        </table>
      </div>
      <div class="erp-sumbox">
        <div class="erp-sumline"><span>قيمة الأعمال المنفذة بالمستخلصات</span><strong>${fmtMoney(f.gross || 0)}</strong></div>
        <div class="erp-sumline"><span>التكاليف النقدية المعتمدة (مطابقة 100% لـ v14)</span><strong class="erp-neg">− ${fmtMoney(act.total)}</strong></div>
        <div class="erp-sumline total"><span>هامش المشروع حتى الآن</span><strong class="${margin >= 0 ? 'erp-pos' : 'erp-neg'}">${fmtMoney(margin)}</strong></div>
        ${unpaidCust > 0 ? `<small style="color:var(--orange);">* ملاحظة: يتضمن المصروف فروق عُهد لم تُسدد للموظفين بعد بقيمة ${fmtMoney(unpaidCust)}.</small>` : ''}
      </div>
    </div>`;
  }).join('');

  const grandMargin = core.round2(grandGross - grandCosts);
  return `<div class="erp-shell">
    <div class="hero-card">
      <div class="hero-label">📊 إجمالي ربحية المشاريع النشطة (محسوبة لحظياً من v14)</div>
      <div class="hero-grid-3">
        <div class="hero-sub"><small>منفذ بالمستخلصات</small><strong style="color:#34d399;">${fmtMoney(grandGross)}</strong></div>
        <div class="hero-sub"><small>تكاليف فعلية</small><strong style="color:#f87171;">${fmtMoney(grandCosts)}</strong></div>
        <div class="hero-sub"><small>إجمالي الهامش</small><strong style="color:#facc15;">${fmtMoney(grandMargin)}</strong></div>
      </div>
    </div>
    ${cards}
  </div>`;
}

/* --- شاشة كميات التنفيذ بالموقع (بدون أسعار بيع للمهندس + اعتماد المعلقات للمدير/ERP) --- */
function renderSiteQuantitiesScreen() {
  const projs = getAllowedProjectsList();
  if (!projs.length) {
    return '<div class="card"><p style="color:var(--muted); text-align:center;">لا توجد مشاريع نشطة متاحة لك حالياً.</p></div>';
  }
  const pid = ensureSelectedPid(ui.pid);
  const canErp = core.canAccessErp();
  const canSubmit = core.canAdd();

  // قراءة بنود المقايسة بدون أسعار (من project_site_boq أو من العقد للمدير)
  let items = siteBoqMap.get(pid)?.items || [];
  if (!items.length && canErp && window.ReviseErpContracts) {
    items = window.ReviseErpContracts.buildSiteBoqPayload(pid).items || [];
  }

  // طلبات الكميات المعلقة
  const pendAll = canErp
    ? qtyRequests.filter((q) => q.status === 'pending')
    : qtyRequests.filter((q) => q.status === 'pending' && q.projectId === pid);

  const pendingBoxHtml = pendAll.length ? `
    <div class="card" style="border-right:4px solid var(--gold);">
      <h3 style="margin:0 0 8px; font-size:14.5px;">🔔 طلبات الكميات المعلّقة <span class="badge">${pendAll.length}</span></h3>
      ${pendAll.map((q) => {
        const siteItem = (siteBoqMap.get(q.projectId)?.items || []).find((x) => x.id === q.boqItemId);
        const curExec = Number(siteItem?.executedQty || 0);
        const cQty = Number(siteItem?.contractQty || 0);
        const nextTotal = q.mode === 'cumulative' ? Number(q.qty || 0) : core.round2(curExec + Number(q.qty || 0));
        const overContract = cQty > 0 && nextTotal > cQty;
        const rBtn = q.receiptId ? `<button type="button" class="sm secondary" onclick="viewReceipt('${core.esc(q.receiptId)}')">🖼️</button>` : '';
        const modeTxt = q.mode === 'cumulative' ? `إجمالي تراكمي = ${fmtNum(q.qty)}` : `إضافة جديدة +${fmtNum(q.qty)}`;
        const isMine = q.createdBy === core.getUser()?.uid;
        return `<div class="tx-item" style="flex-direction:column; align-items:stretch; gap:5px;">
          <div class="between" style="align-items:flex-start;">
            <div style="flex:1;">
              <strong>${core.esc(q.boqItemName || 'بند')}</strong> <span class="erp-chip brand">${core.esc(q.projectName || projNameById(q.projectId))}</span><br>
              <small style="color:var(--muted);">${core.esc(q.txDate || '')} • ✍️ ${core.esc(q.createdByName || '')} • ${modeTxt} ${core.esc(q.unit || '')}</small>
              ${q.note ? `<div style="font-size:12px; margin-top:2px;">📝 ${core.esc(q.note)}</div>` : ''}
              <div style="font-size:11.5px; color:var(--primary); margin-top:2px;">المنفذ الحالي: ${fmtNum(curExec)} ← بعد الاعتماد: <strong>${fmtNum(nextTotal)} ${core.esc(q.unit || '')}</strong></div>
              ${overContract ? `<div class="fraud-alert">⚠️ تنبيه: الكمية الجديدة (${fmtNum(nextTotal)}) تتجاوز كمية العقد (${fmtNum(cQty)}) — يحتاج أمر تغييري!</div>` : ''}
            </div>
            ${rBtn}
          </div>
          <div class="row" style="justify-content:flex-end;">
            ${canErp ? `
              <button type="button" class="sm green" data-es-approveqty="${core.esc(q.id)}">✅ اعتماد وإضافة للمستخلص</button>
              <button type="button" class="sm red" data-es-rejectqty="${core.esc(q.id)}">❌ رفض</button>` : ''}
            ${(!canErp && isMine) ? `<button type="button" class="sm red" data-es-delqty="${core.esc(q.id)}">حذف طلبي</button>` : ''}
          </div>
        </div>`;
      }).join('')}
    </div>` : '';

  const rowsHtml = items.map((it) => {
    const cQty = Number(it.contractQty || 0);
    const eQty = Number(it.executedQty || 0);
    const rem = core.round2(cQty - eQty);
    const pct = cQty > 0 ? (eQty / cQty) * 100 : 0;
    const over = cQty > 0 && eQty > cQty;
    return `<tr>
      <td class="head" data-l="البند">${core.esc(it.name)}</td>
      <td data-l="الوحدة">${core.esc(it.unit)}</td>
      <td class="r" data-l="كمية العقد">${fmtNum(cQty)}</td>
      <td class="r" data-l="المنفذ المعتمد"><strong>${fmtNum(eQty)}</strong></td>
      <td class="r" data-l="المتبقي"><strong style="color:${over ? 'var(--red)' : 'var(--green)'};">${over ? 'زيادة +' + fmtNum(Math.abs(rem)) : fmtNum(rem)}</strong></td>
      <td data-l="نسبة الإنجاز">
        <div class="row" style="flex-wrap:nowrap; gap:6px;">
          <div class="erp-bar" style="flex:1; min-width:55px;"><i class="${over ? 'red' : ''}" style="width:${Math.min(100, pct)}%"></i></div>
          <strong style="font-size:11.5px;">${fmtPct(pct)}</strong>
        </div>
      </td>
      <td data-l="تحديث">${canSubmit ? `<button type="button" class="sm gold" data-es-modal="addQtyReq" data-pid="${core.esc(pid)}" data-bid="${core.esc(it.id)}">+ كمية</button>` : '—'}</td>
    </tr>`;
  }).join('');

  // سجل آخر الطلبات المعالجة لهذا المشروع
  const recentHist = qtyRequests.filter((q) => q.projectId === pid && q.status !== 'pending').slice(0, 8);
  const histHtml = recentHist.length ? `
    <div class="card">
      <h3 style="margin:0 0 6px; font-size:14px;">📜 آخر تحديثات الكميات — ${core.esc(projNameById(pid))}</h3>
      ${recentHist.map((q) => `
        <div class="tx-item">
          <div style="flex:1;">
            <strong>${core.esc(q.boqItemName || '')}</strong>
            <span class="pill ${q.status === 'approved' ? 'pill-approved' : 'pill-rejected'}">${q.status === 'approved' ? '✅ معتمد' : '❌ مرفوض'}</span><br>
            <small style="color:var(--muted);">${core.esc(q.txDate || '')} • ✍️ ${core.esc(q.createdByName || '')}${q.rejectReason ? ' • سبب الرفض: ' + core.esc(q.rejectReason) : ''}</small>
          </div>
          <strong style="font-size:13px;">${q.mode === 'cumulative' ? '=' : '+'}${fmtNum(q.qty)} ${core.esc(q.unit || '')}</strong>
        </div>`).join('')}
    </div>` : '';

  return `<div class="erp-shell">
    <div class="card" style="padding:12px;">
      <div class="between" style="margin-bottom:6px;">
        <strong style="color:var(--primary);">📐 كميات التنفيذ بالموقع (بدون أسعار)</strong>
        ${(canSubmit && items.length) ? `<button type="button" class="sm gold" data-es-modal="addQtyReq" data-pid="${core.esc(pid)}">+ إرسال كمية</button>` : ''}
      </div>
      <select data-es-action="selectSiteProj">
        ${projs.map((p) => `<option value="${core.esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${core.esc(p.name)}</option>`).join('')}
      </select>
      ${!canErp ? '<small style="display:block; color:var(--muted); margin-top:6px;">🔒 تظهر هنا البنود والكميات فقط دون أسعار البيع — أي كمية ترسلها تصل للإدارة للاعتماد.</small>' : ''}
    </div>
    ${pendingBoxHtml}
    <div class="card">
      <div class="between" style="margin-bottom:4px;">
        <h3 style="margin:0; font-size:14.5px;">بنود ${core.esc(projNameById(pid))}</h3>
        ${canErp ? `<button type="button" class="sm secondary" onclick="window.ReviseCore.openErpView('contracts',{projectId:'${core.esc(pid)}',subTab:'boq'})">تعديل المقايسة</button>` : ''}
      </div>
      <div class="erp-tblwrap">
        <table class="erp-tbl">
          <thead><tr><th>البند</th><th>وحدة</th><th class="r">كمية العقد</th><th class="r">المنفذ</th><th class="r">المتبقي</th><th>الإنجاز</th><th>تحديث</th></tr></thead>
          <tbody>${rowsHtml || '<tr><td colspan="7" style="text-align:center; color:var(--muted);">لم تُضَف بنود مقايسة لهذا المشروع بعد من قِبل الإدارة.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    ${histHtml}
  </div>`;
}

/* --- شاشة التقرير اليومي للموقع (مربوط بعدد حضور v14 تلقائياً) --- */
function renderDailyReportsScreen() {
  const projs = getAllowedProjectsList();
  if (!projs.length) {
    return '<div class="card"><p style="color:var(--muted); text-align:center;">لا توجد مشاريع نشطة متاحة لك حالياً.</p></div>';
  }
  const pid = ensureSelectedPid(ui.pid);
  const reps = dailyReports
    .filter((r) => r.projectId === pid)
    .sort((a, b) => (b.txDate || '').localeCompare(a.txDate || '') || ((b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)));

  return `<div class="erp-shell">
    <div class="card" style="padding:12px;">
      <div class="between" style="margin-bottom:6px;">
        <strong style="color:var(--primary);">📋 التقرير اليومي للموقع</strong>
        ${core.canAdd() ? `<button type="button" class="sm gold" data-es-modal="addDailyRep" data-pid="${core.esc(pid)}">+ تقرير اليوم</button>` : ''}
      </div>
      <select data-es-action="selectSiteProj">
        ${projs.map((p) => `<option value="${core.esc(p.id)}" ${p.id === pid ? 'selected' : ''}>${core.esc(p.name)}</option>`).join('')}
      </select>
    </div>

    <div class="card">
      <h3 style="margin:0 0 8px; font-size:14.5px;">تقارير ${core.esc(projNameById(pid))} (${reps.length})</h3>
      ${reps.length ? reps.map((r) => {
        const canDel = core.isAdmin();
        const rBtn = r.receiptId ? `<button type="button" class="sm secondary" onclick="viewReceipt('${core.esc(r.receiptId)}')">🖼️ صورة الموقع</button>` : '';
        return `<div class="tx-item" style="flex-direction:column; align-items:stretch; gap:5px;">
          <div class="between">
            <div>
              <strong>📅 ${core.esc(r.txDate || '')}</strong>
              <span class="erp-chip brand">👷 ${Number(r.workersCount || 0)} عامل</span>
              ${Number(r.autoWorkersCount || 0) > 0 ? `<span class="erp-chip green">حضور v14: ${r.autoWorkersCount}</span>` : ''}
            </div>
            <small style="color:var(--muted);">✍️ ${core.esc(r.createdByName || '')}</small>
          </div>
          <div style="font-size:13px;"><strong>الأعمال المنفذة:</strong> ${core.esc(r.works || '')}</div>
          ${r.materials ? `<div style="font-size:12px; color:var(--muted);"><strong>خامات واصلة:</strong> ${core.esc(r.materials)}</div>` : ''}
          ${r.notes ? `<div style="font-size:12px; color:var(--muted);"><strong>ملاحظات/معوقات:</strong> ${core.esc(r.notes)}</div>` : ''}
          <div class="row" style="justify-content:flex-end;">
            ${rBtn}
            ${canDel ? `<button type="button" class="sm red" data-es-delrep="${core.esc(r.id)}">حذف</button>` : ''}
          </div>
        </div>`;
      }).join('') : '<p style="color:var(--muted); text-align:center; font-size:13px;">لا توجد تقارير يومية مسجلة لهذا المشروع بعد.</p>'}
    </div>
  </div>`;
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

function openSiteModal(kind, pid, extraBid = '') {
  if (kind === 'editBudget') {
    if (!core.canAccessErp() || !window.ReviseErpContracts) return;
    const c = window.ReviseErpContracts.getContract(pid);
    openErpModal(`✏️ ضبط الميزانية التقديرية — ${projNameById(pid)}`, `
      <p style="font-size:12px; color:var(--muted); margin-top:0;">أدخل الميزانية التقديرية لكل بند تكلفة (يُقارن بها الصرف الفعلي من دفتر <code>v14</code> لحظياً).</p>
      <form data-es-form="editBudget" data-pid="${core.esc(pid)}">
        ${COST_GROUPS.map((g, idx) => `
          <div class="erp-field">
            <label>${g} (جنيه)</label>
            <input type="number" name="bg_${idx}" min="0" step="any" value="${Number(c.budget?.[g] || 0)}">
          </div>`).join('')}
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ الميزانية</button>
      </form>`);
  } else if (kind === 'addQtyReq') {
    let items = siteBoqMap.get(pid)?.items || [];
    if (!items.length && core.canAccessErp() && window.ReviseErpContracts) {
      items = window.ReviseErpContracts.buildSiteBoqPayload(pid).items || [];
    }
    if (!items.length) { core.showToast('لا توجد بنود مقايسة مضافة لهذا المشروع بعد', { error: true }); return; }
    const selId = extraBid || items[0].id;
    openErpModal(`📐 إرسال كمية منفذة للاعتماد — ${projNameById(pid)}`, `
      <form data-es-form="addQtyReq" data-pid="${core.esc(pid)}" id="esQtyReqForm">
        <div class="erp-fgrid">
          <div class="erp-field full"><label>البند</label>
            <select name="boqItemId" id="esQtyItemSel">
              ${items.map((it) => `<option value="${core.esc(it.id)}" ${it.id === selId ? 'selected' : ''}>${core.esc(it.name)} (منفذ: ${fmtNum(it.executedQty)} / عقد: ${fmtNum(it.contractQty)} ${core.esc(it.unit)})</option>`).join('')}
            </select>
          </div>
          <div class="erp-field full"><label>طريقة الإدخال</label>
            <select name="mode" id="esQtyModeSel">
              <option value="delta" selected>➕ كمية إضافية جديدة نُفّذت الآن (الافتراضي والأأمن)</option>
              <option value="cumulative">📊 الإجمالي التراكمي المنفذ حتى اليوم (حصر هندسي)</option>
            </select>
          </div>
          <div class="erp-field"><label>الكمية</label><input type="number" name="qty" id="esQtyValInp" step="any" min="0.01" required placeholder="مثلاً: 150"></div>
          <div class="erp-field"><label>التاريخ</label><input type="date" name="txDate" value="${core.esc(core.getLocalDateStr())}" required></div>
          <div class="erp-field full"><div id="esQtyPreview" class="erp-sumbox" style="margin-top:4px; font-size:12px;"></div></div>
          <div class="erp-field full"><label>تفاصيل / مكان التنفيذ (اختياري)</label><input name="note" placeholder="مثلاً: محارة الدور الرابع الواجهة البحرية"></div>
          <div class="erp-field full"><label>📷 صورة إثبات من الموقع (اختياري)</label><input type="file" id="esQtyReceipt" accept="image/*"></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">📤 إرسال للاعتماد</button>
      </form>`);
    updateQtyReqPreview(pid);
  } else if (kind === 'addDailyRep') {
    const today = core.getLocalDateStr();
    const autoW = countAutoAttendance(pid, today);
    openErpModal(`📋 التقرير اليومي للموقع — ${projNameById(pid)}`, `
      <form data-es-form="addDailyRep" data-pid="${core.esc(pid)}">
        <div class="erp-fgrid">
          <div class="erp-field"><label>التاريخ</label><input type="date" name="txDate" id="esRepDate" value="${core.esc(today)}" required data-es-repdate="${core.esc(pid)}"></div>
          <div class="erp-field"><label>عدد العمالة (مسجّل بحضور v14: <span id="esAutoWCnt">${autoW}</span>)</label><input type="number" name="workersCount" id="esWorkersCount" min="0" value="${autoW}" required></div>
          <input type="hidden" name="autoWorkersCount" id="esAutoWVal" value="${autoW}">
          <div class="erp-field full"><label>الأعمال المنفذة اليوم (إجباري)</label><textarea name="works" required maxlength="1450" placeholder="مثلاً: دهان وجه أول واجهة أمامية + شد سقالات الدور السابع"></textarea></div>
          <div class="erp-field full"><label>خامات واصلة للموقع اليوم (اختياري)</label><input name="materials" placeholder="مثلاً: 20 بستلة جوتن + 5 شيكارة معجون"></div>
          <div class="erp-field full"><label>ملاحظات / معوقات / طلبات (اختياري)</label><textarea name="notes" placeholder="أي تعطيل، طقس، أو طلبات المالك/الاستشاري"></textarea></div>
          <div class="erp-field full"><label>📷 صورة من الموقع (اختياري)</label><input type="file" id="esRepReceipt" accept="image/*"></div>
        </div>
        <button type="submit" class="green" style="margin-top:12px;">✅ حفظ التقرير اليومي</button>
      </form>`);
  }
}

function updateQtyReqPreview(pid) {
  const box = document.getElementById('esQtyPreview');
  const itemSel = document.getElementById('esQtyItemSel');
  const modeSel = document.getElementById('esQtyModeSel');
  const valInp = document.getElementById('esQtyValInp');
  if (!box || !itemSel || !modeSel || !valInp) return;

  let items = siteBoqMap.get(pid)?.items || [];
  if (!items.length && core.canAccessErp() && window.ReviseErpContracts) {
    items = window.ReviseErpContracts.buildSiteBoqPayload(pid).items || [];
  }
  const it = items.find((x) => x.id === itemSel.value);
  if (!it) { box.innerHTML = ''; return; }
  const q = Number(valInp.value || 0);
  const curExec = Number(it.executedQty || 0);
  const cQty = Number(it.contractQty || 0);
  const nextExec = modeSel.value === 'cumulative' ? q : core.round2(curExec + q);
  const over = cQty > 0 && nextExec > cQty;
  box.innerHTML = `
    <div class="erp-sumline"><span>المنفذ المعتمد حالياً</span><strong>${fmtNum(curExec)} ${core.esc(it.unit)}</strong></div>
    <div class="erp-sumline"><span>كمية العقد</span><strong>${fmtNum(cQty)} ${core.esc(it.unit)}</strong></div>
    <div class="erp-sumline total"><span>الإجمالي المتوقع بعد الاعتماد</span><strong style="color:${over ? 'var(--red)' : 'var(--green)'};">${fmtNum(nextExec)} ${core.esc(it.unit)}</strong></div>
    ${over ? `<div style="color:var(--red); font-size:11.5px; font-weight:700;">⚠️ هذه الكمية تتجاوز كمية العقد (${fmtNum(cQty)}) — سيظهر تنبيه للإدارة بضرورة عمل أمر تغييري.</div>` : ''}`;
}

/* ============ اعتماد / رفض طلب كمية معلّق ============ */
async function approveQtyRequest(qid, btn) {
  if (!core.canAccessErp() || !window.ReviseErpContracts) return;
  const q = qtyRequests.find((x) => x.id === qid);
  if (!q) return;
  const ec = window.ReviseErpContracts;
  const c = ec.getContract(q.projectId);
  const eff = ec.getEffectiveBoq(q.projectId);
  const boqIt = eff.find((b) => b.id === q.boqItemId);
  const sts = ec.getProjectStatements(q.projectId);
  const lastStmtQty = sts.length ? Number(sts[sts.length - 1].qtys?.[q.boqItemId] || 0) : 0;
  const curExec = Math.max(Number(c.approvedSiteQtys?.[q.boqItemId] || 0), lastStmtQty);
  const nextCumulative = q.mode === 'cumulative' ? core.round2(Number(q.qty || 0)) : core.round2(curExec + Number(q.qty || 0));

  if (boqIt && boqIt.qty > 0 && nextCumulative > boqIt.qty) {
    if (!confirm(`⚠️ تنبيه: الكمية الجديدة (${fmtNum(nextCumulative)} ${boqIt.unit}) تتجاوز كمية العقد (${fmtNum(boqIt.qty)} ${boqIt.unit})!\nهل تريد اعتمادها الآن (وتذكّر إضافة أمر تغييري للزيادة)؟`)) return;
  }

  await core.withBusy(btn, 'جاري...', async () => {
    const { doc, writeBatch, serverTimestamp } = core.fs;
    c.approvedSiteQtys = { ...(c.approvedSiteQtys || {}), [q.boqItemId]: nextCumulative };
    const cleanContract = {
      ...c,
      projectId: q.projectId,
      updatedBy: core.getUser().uid,
      updatedByName: core.getUserName(),
      updatedAt: serverTimestamp()
    };
    const batch = writeBatch(core.db);
    batch.update(doc(core.db, 'quantity_requests', qid), {
      status: 'approved',
      appliedCumulative: nextCumulative,
      approvedBy: core.getUser().uid,
      approvedByName: core.getUserName(),
      approvedAt: serverTimestamp()
    });
    batch.set(doc(core.db, 'project_contracts', q.projectId), cleanContract);
    batch.set(doc(core.db, 'project_site_boq', q.projectId), ec.buildSiteBoqPayload(q.projectId, cleanContract));
    if (core.isAdmin()) {
      core.addAuditToBatch(batch, 'update', 'project_contracts', q.projectId, null, cleanContract, `اعتماد كمية موقع (${q.boqItemName}): أصبح المنفذ ${fmtNum(nextCumulative)} ${q.unit || ''}`);
    }
    await batch.commit();
    core.showToast(`✅ تم اعتماد الكمية (${fmtNum(nextCumulative)} ${q.unit || ''}) وستظهر تلقائياً في المستخلص القادم`);
  });
}

async function rejectQtyRequest(qid, btn) {
  if (!core.canAccessErp()) return;
  const reason = prompt('سبب رفض الكمية (اختياري):');
  if (reason === null) return;
  await core.withBusy(btn, '...', async () => {
    const { doc, updateDoc, serverTimestamp } = core.fs;
    await updateDoc(doc(core.db, 'quantity_requests', qid), {
      status: 'rejected',
      rejectReason: reason.trim(),
      approvedBy: core.getUser().uid,
      approvedByName: core.getUserName(),
      approvedAt: serverTimestamp()
    });
    core.showToast('تم رفض طلب الكمية');
  });
}

/* ============ معالجة الأحداث ============ */
function bindEvents() {
  document.addEventListener('click', async (e) => {
    if (!core || !core.isStaff()) return;

    const togAl = e.target.closest('[data-es-togglealerts]');
    if (togAl) { alertsExpanded = !alertsExpanded; renderHomeAlertsCard(); return; }

    const alGo = e.target.closest('[data-es-alertgo]');
    if (alGo) {
      const act = alGo.dataset.esAlertgo;
      const pid = alGo.dataset.pid || null;
      if (act === 'approvals_home') window.scrollToApprovals?.();
      else if (act === 'custody_home') window.scrollToCustody?.();
      else if (act) core.openErpView(act, pid ? { projectId: pid } : {});
      return;
    }

    const mod = e.target.closest('[data-es-modal]');
    if (mod) { openSiteModal(mod.dataset.esModal, mod.dataset.pid, mod.dataset.bid || ''); return; }

    const appQ = e.target.closest('[data-es-approveqty]');
    if (appQ) { await approveQtyRequest(appQ.dataset.esApproveqty, appQ); return; }

    const rejQ = e.target.closest('[data-es-rejectqty]');
    if (rejQ) { await rejectQtyRequest(rejQ.dataset.esRejectqty, rejQ); return; }

    const delQ = e.target.closest('[data-es-delqty]');
    if (delQ) {
      if (!confirm('حذف طلب الكمية المعلّق؟')) return;
      await core.withBusy(delQ, '...', async () => {
        await core.fs.deleteDoc(core.fs.doc(core.db, 'quantity_requests', delQ.dataset.esDelqty));
        core.showToast('تم حذف الطلب');
      });
      return;
    }

    const delR = e.target.closest('[data-es-delrep]');
    if (delR && core.isAdmin()) {
      if (!confirm('حذف التقرير اليومي؟')) return;
      await core.withBusy(delR, '...', async () => {
        await core.fs.deleteDoc(core.fs.doc(core.db, 'daily_reports', delR.dataset.esDelrep));
        core.showToast('تم حذف التقرير');
      });
    }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('[data-es-action="selectSiteProj"]')) {
      ui.pid = e.target.value; core.refreshErpView();
    } else if (e.target.id === 'esQtyItemSel' || e.target.id === 'esQtyModeSel') {
      const f = document.getElementById('esQtyReqForm');
      if (f) updateQtyReqPreview(f.dataset.pid);
    } else if (e.target.matches('[data-es-repdate]')) {
      const pid = e.target.dataset.esRepdate;
      const cnt = countAutoAttendance(pid, e.target.value);
      const sp = document.getElementById('esAutoWCnt');
      const hid = document.getElementById('esAutoWVal');
      const inp = document.getElementById('esWorkersCount');
      if (sp) sp.innerText = cnt;
      if (hid) hid.value = cnt;
      if (inp) inp.value = cnt;
    }
  });

  document.addEventListener('input', (e) => {
    if (e.target.id === 'esQtyValInp') {
      const f = document.getElementById('esQtyReqForm');
      if (f) updateQtyReqPreview(f.dataset.pid);
    }
  });

  document.addEventListener('submit', async (e) => {
    const form = e.target.closest('form[data-es-form]');
    if (!form || !core || !core.isStaff()) return;
    e.preventDefault();
    const kind = form.dataset.esForm;
    const pid = form.dataset.pid;
    const fd = new FormData(form);
    const btn = form.querySelector('button[type="submit"]');

    await core.withBusy(btn, 'جاري الحفظ...', async () => {
      if (kind === 'editBudget') {
        if (!core.canAccessErp() || !window.ReviseErpContracts) throw new Error('صلاحية غير كافية');
        const c = window.ReviseErpContracts.getContract(pid);
        const nextBudget = {};
        COST_GROUPS.forEach((g, idx) => {
          nextBudget[g] = Math.max(0, core.round2(Number(fd.get(`bg_${idx}`) || 0)));
        });
        c.budget = nextBudget;
        await window.ReviseErpContracts.saveContractDoc(pid, c, `تحديث ميزانية ${projNameById(pid)}`);
        closeErpModal();
        core.showToast('✅ تم حفظ الميزانية التقديرية');
      } else if (kind === 'addQtyReq') {
        const boqItemId = String(fd.get('boqItemId') || '');
        const mode = String(fd.get('mode') || 'delta');
        const qty = core.round2(Number(fd.get('qty') || 0));
        const txDate = String(fd.get('txDate') || core.getLocalDateStr());
        const note = String(fd.get('note') || '').trim();
        if (!boqItemId || qty <= 0) throw new Error('اختر البند وأدخل كمية أكبر من صفر');

        let items = siteBoqMap.get(pid)?.items || [];
        if (!items.length && core.canAccessErp() && window.ReviseErpContracts) {
          items = window.ReviseErpContracts.buildSiteBoqPayload(pid).items || [];
        }
        const it = items.find((x) => x.id === boqItemId);
        let receiptId = null;
        const file = document.getElementById('esQtyReceipt')?.files?.[0];
        if (file) {
          const imgData = await core.compressImage(file, 800, 470000);
          const rRef = await core.fs.addDoc(core.fs.collection(core.db, 'receipts'), {
            imageData: imgData,
            createdBy: core.getUser().uid,
            workerId: null,
            createdAt: core.fs.serverTimestamp()
          });
          receiptId = rRef.id;
        }
        // حقول مطابقة 100% لقائمة hasOnly في firestore.rules
        const payload = {
          projectId: pid,
          projectName: projNameById(pid),
          boqItemId,
          boqItemName: it?.name || 'بند',
          unit: it?.unit || 'وحدة',
          mode: mode === 'cumulative' ? 'cumulative' : 'delta',
          qty,
          txDate,
          note,
          status: 'pending',
          receiptId,
          hasReceipt: !!receiptId,
          createdBy: core.getUser().uid,
          createdByName: core.getUserName(),
          createdByRole: core.getUserRole(),
          createdAt: core.fs.serverTimestamp()
        };
        await core.fs.addDoc(core.fs.collection(core.db, 'quantity_requests'), payload);
        closeErpModal();
        core.showToast('✅ تم إرسال الكمية المنفذة للإدارة للاعتماد');
      } else if (kind === 'addDailyRep') {
        const txDate = String(fd.get('txDate') || core.getLocalDateStr());
        const works = String(fd.get('works') || '').trim();
        const workersCount = Math.max(0, parseInt(fd.get('workersCount') || '0', 10) || 0);
        const autoWorkersCount = Math.max(0, parseInt(fd.get('autoWorkersCount') || '0', 10) || 0);
        const materials = String(fd.get('materials') || '').trim();
        const notes = String(fd.get('notes') || '').trim();
        if (!works) throw new Error('اكتب الأعمال المنفذة اليوم');
        let receiptId = null;
        const file = document.getElementById('esRepReceipt')?.files?.[0];
        if (file) {
          const imgData = await core.compressImage(file, 800, 470000);
          const rRef = await core.fs.addDoc(core.fs.collection(core.db, 'receipts'), {
            imageData: imgData,
            createdBy: core.getUser().uid,
            workerId: null,
            createdAt: core.fs.serverTimestamp()
          });
          receiptId = rRef.id;
        }
        // حقول مطابقة 100% لقائمة hasOnly في firestore.rules
        const payload = {
          projectId: pid,
          projectName: projNameById(pid),
          txDate,
          works: works.slice(0, 1480),
          workersCount,
          autoWorkersCount,
          materials,
          notes,
          receiptId,
          hasReceipt: !!receiptId,
          createdBy: core.getUser().uid,
          createdByName: core.getUserName(),
          createdByRole: core.getUserRole(),
          createdAt: core.fs.serverTimestamp()
        };
        await core.fs.addDoc(core.fs.collection(core.db, 'daily_reports'), payload);
        closeErpModal();
        core.showToast('✅ تم حفظ التقرير اليومي للموقع');
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
  if (!core.isStaff()) return api;
  if (initialized) return api;
  initialized = true;

  const { collection, doc, query, where, onSnapshot } = core.fs;
  const onErr = (err) => {
    core.logClientError('erp-site', err);
    core.showToast(core.friendlyError(err), { error: true });
  };

  if (core.canAccessErp()) {
    unsubs.push(onSnapshot(collection(core.db, 'project_site_boq'), (snap) => {
      const next = new Map();
      snap.docs.forEach((d) => next.set(d.id, { id: d.id, ...d.data() }));
      siteBoqMap = next;
      core.onErpDataChanged();
    }, onErr));

    unsubs.push(onSnapshot(collection(core.db, 'quantity_requests'), (snap) => {
      qtyRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      core.onErpDataChanged();
    }, onErr));

    unsubs.push(onSnapshot(collection(core.db, 'daily_reports'), (snap) => {
      dailyReports = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (b.txDate || '').localeCompare(a.txDate || ''));
      core.onErpDataChanged();
    }, onErr));
  } else {
    // المهندس/الموظف: يقرأ project_site_boq بمستند كل مشروع مسند إليه فقط (متوافق 100% مع pid in myProjects)
    const pList = (core.getAssignedProjects() || []).slice(0, 30);
    pList.forEach((pid) => {
      unsubs.push(onSnapshot(doc(core.db, 'project_site_boq', pid), (snap) => {
        if (snap.exists()) siteBoqMap.set(pid, { id: snap.id, ...snap.data() });
        else siteBoqMap.delete(pid);
        core.onErpDataChanged();
      }, onErr));
    });

    if (pList.length > 0) {
      unsubs.push(onSnapshot(query(collection(core.db, 'quantity_requests'), where('projectId', 'in', pList)), (snap) => {
        qtyRequests = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
        core.onErpDataChanged();
      }, onErr));

      unsubs.push(onSnapshot(query(collection(core.db, 'daily_reports'), where('projectId', 'in', pList)), (snap) => {
        dailyReports = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.txDate || '').localeCompare(a.txDate || ''));
        core.onErpDataChanged();
      }, onErr));
    }
  }

  return api;
}

export function dispose() {
  unsubs.forEach((u) => { try { u && u(); } catch (e) {} });
  unsubs = [];
  initialized = false;
  siteBoqMap = new Map();
  qtyRequests = [];
  dailyReports = [];
}

const api = {
  COST_GROUPS,
  init,
  dispose,
  renderView,
  resolveCostGroup,
  computeProjectActualCosts,
  countAutoAttendance,
  getPendingQtyRequests,
  computeSmartAlerts,
  renderHomeAlertsCard
};

window.ReviseErpSite = api;
export default api;

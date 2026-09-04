/* Two independent accounts (tabs). Each holds its own budget, categories,
   expenses and money-in history, so reports and logs never mix.
   An account: { totalBudget, categories: [...], moneyIn: [{id, note, amount, dateRaw, date, loggedAt}] } */
const ACCOUNT_KEYS = ['bank', 'cash'];
const DEFAULT_SETTINGS = { currency: '₱', labels: { bank: 'Bank', cash: 'Cash' }, cycleStart: 1, appName: 'Bank', appTagline: 'Money Tracker', lockAfter: 300, catSort: 'custom', catSortDir: 'asc', theme: 'default', accent: '#72383D', bgMode: 'default', bgOpacity: 100 };
function settings() { return store.settings || (store.settings = { ...DEFAULT_SETTINGS, labels: { ...DEFAULT_SETTINGS.labels } }) }
function cur() { return settings().currency || '₱' }
function mask() { return cur() + '••••••' }
function cycleStart() { const n = parseInt(settings().cycleStart); return isNaN(n) ? 1 : Math.min(28, Math.max(1, n)) }
function blankAccount() { return { totalBudget: 0, categories: [], moneyIn: [], loans: [], goals: [] } }
/* Reading is also where damaged rows are dropped. Reporting a bad row
   without removing it just moves the failure into the first render, so
   anything that cannot be used is left behind here and named in the
   notice the user sees. */
function normalizeAccount(a) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) return blankAccount();
    const rows = Array.isArray(a.categories) ? a.categories : [];
    const categories = rows
        .filter(c => c && typeof c === 'object' && typeof c.name === 'string')
        .map(c => Object.assign({}, c, {
            expenses: (Array.isArray(c.expenses) ? c.expenses : [])
                .filter(e => e && typeof e === 'object' && !isNaN(Number(e.amount))),
            periods: (c.periods && typeof c.periods === 'object' && !Array.isArray(c.periods)) ? c.periods : {}
        }));
    const usable = list => (Array.isArray(list) ? list : [])
        .filter(x => x && typeof x === 'object' && !isNaN(Number(x.amount)));
    return {
        totalBudget: Number(a.totalBudget) || 0,
        categories,
        moneyIn: usable(a.moneyIn),
        loans: (Array.isArray(a.loans) ? a.loans : []).filter(l => l && typeof l === 'object' && typeof l.name === 'string'),
        goals: (Array.isArray(a.goals) ? a.goals : []).filter(g => g && typeof g === 'object' && typeof g.name === 'string')
    };
}
let store = { active: 'bank', settings: { ...DEFAULT_SETTINGS, labels: { ...DEFAULT_SETTINGS.labels } }, accounts: { bank: blankAccount(), cash: blankAccount() } };
let state = store.accounts.bank;   // the account the UI is currently showing
let editingId = null;

function accountLabel(key) {
    const l = settings().labels || {};
    return (l[key] || DEFAULT_SETTINGS.labels[key] || 'Bank');
}
function activeLabel() { return accountLabel(store.active) }
/* ── STORAGE SAFETY ──
   Browsers refuse to save in a private window, when site data is switched off,
   or when the device is out of space. Those throw, so every read and write goes
   through here and a failure is shown instead of being swallowed. */
let storageOk = true;
function lsGet(key) { try { return localStorage.getItem(key) } catch (e) { return null } }
function lsSet(key, value) {
    try { localStorage.setItem(key, value); return { ok: true } }
    catch (e) { return { ok: false, err: e } }
}
function lsRemove(key) { try { localStorage.removeItem(key) } catch (e) { } }
function storageWorks() {
    const probe = lsSet('bank_probe', '1');
    if (probe.ok) lsRemove('bank_probe');
    return probe.ok;
}
function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);
}
function showStorageAlert(kind, title, msg, actions) {
    const el = document.getElementById('storageAlert'); if (!el) return;
    el.classList.toggle('warn', kind === 'warn');
    document.getElementById('storageAlertTitle').textContent = title;
    document.getElementById('storageAlertMsg').innerHTML = msg;
    document.getElementById('storageAlertActions').innerHTML = actions;
    el.classList.add('show');
}
function hideStorageAlert() {
    const el = document.getElementById('storageAlert'); if (el) el.classList.remove('show');
}
function reportSaveFailure(err) {
    storageOk = false;
    const msg = isQuotaError(err)
        ? 'This device has no room left to store your records, so nothing you enter is being kept. Free up some space on the device, then tap Try again. Download a backup first so this session is not lost.'
        : 'Your browser is not letting this page save anything — usually a private/incognito window, or site data switched off for this site. Everything you enter now will disappear when you close the tab. Download a backup to keep it.';
    showStorageAlert('danger', 'Your changes are not being saved', msg,
        '<button class="storage-btn" onclick="exportData()">Download a backup</button>' +
        '<button class="storage-btn ghost" onclick="retryStorage()">Try again</button>');
}
function retryStorage() {
    if (!storageWorks()) { showToast('Still cannot save — check your browser settings'); return }
    storageOk = true; hideStorageAlert(); save();
    if (storageOk) showToast('Saving works again ✓');
}
function save() {
    /* the screen is showing an empty tracker because the stored copy
       could not be read — writing now would destroy it */
    if (recoveryMode) {
        showStorageAlert('warn', 'Nothing is being saved yet',
            'Your stored records could not be read, so the tracker is holding off on saving to avoid writing over them. ' +
            'Choose what to do with them first.', recoveryActions());
        return false;
    }
    const res = lsSet('bank_v4', JSON.stringify(store));
    if (!res.ok) { reportSaveFailure(res.err); return false }
    if (!storageOk) { storageOk = true; hideStorageAlert() }
    refreshSnapshot();
    return true;
}
/* keepSettings: for a backup that carries records but no settings. Without
   it such a file silently reset the currency, both tab names, the budget
   cycle, the theme and even the PIN back to defaults — losing settings the
   file never claimed to replace. Starting fresh still wants the defaults,
   so it is only asked for on import. */
function adoptStore(data, keepSettings) {
    const active = (data && data.active === 'cash') ? 'cash' : 'bank';
    const accts = (data && data.accounts) || {};
    const inSet = (data && data.settings) || (keepSettings ? (store.settings || {}) : {});
    store = {
        active,
        settings: {
            currency: inSet.currency || DEFAULT_SETTINGS.currency,
            labels: {
                bank: (inSet.labels && inSet.labels.bank) || DEFAULT_SETTINGS.labels.bank,
                cash: (inSet.labels && inSet.labels.cash) || DEFAULT_SETTINGS.labels.cash
            },
            cycleStart: Math.min(28, Math.max(1, parseInt(inSet.cycleStart) || 1)),
            appName: inSet.appName || DEFAULT_SETTINGS.appName,
            appTagline: inSet.appTagline || DEFAULT_SETTINGS.appTagline,
            pin: inSet.pin || null,
            lockAfter: inSet.lockAfter === 0 ? 0 : (parseInt(inSet.lockAfter) || DEFAULT_SETTINGS.lockAfter),
            catSort: ['custom', 'name', 'remaining', 'spent'].indexOf(inSet.catSort) >= 0 ? inSet.catSort : 'custom',
            catSortDir: inSet.catSortDir === 'desc' ? 'desc' : 'asc',
            theme: inSet.theme || DEFAULT_SETTINGS.theme,
            accent: inSet.accent || DEFAULT_SETTINGS.accent,
            bgMode: ['default', 'custom', 'none'].indexOf(inSet.bgMode) >= 0 ? inSet.bgMode : 'default',
            bgOpacity: inSet.bgOpacity === undefined ? 100 : Math.max(0, Math.min(100, parseInt(inSet.bgOpacity) || 0))
        },
        accounts: { bank: normalizeAccount(accts.bank), cash: normalizeAccount(accts.cash) }
    };
    Object.values(store.accounts).forEach(a => (a.loans || []).forEach(l => {
        if (!l.dueDay && l.dueRaw) l.dueDay = parseInt(String(l.dueRaw).slice(8, 10));
        delete l.dueRaw;
    }));
    if (data && data.lastBackupAt) store.lastBackupAt = data.lastBackupAt;
    state = store.accounts[store.active];
}
/* ════════════════════════════════════════════════════════════════
   CORRUPT-DATA RECOVERY

   Three things can go wrong with what is stored on this device, and
   only the first used to be noticed:

     · the text is not JSON at all — a half-written save, a browser
       that ran out of room mid-write
     · it is valid JSON but not a tracker — the wrong key, a file
       pasted in by hand, a sync tool that replaced the value
     · it is a tracker but parts of it are the wrong shape — a
       categories list that is not a list, amounts that are not
       numbers

   All three now say so. Nothing is deleted: the unreadable text is
   kept, saving is held back so a stray click cannot write over it,
   and recovery is offered from an automatic last-good copy, from a
   backup file, or by deliberately starting fresh.
   ════════════════════════════════════════════════════════════════ */

const UNREADABLE_KEY = 'bank_v4_unreadable';
const SNAPSHOT_KEY = 'bank_v4_lastgood';
const SNAPSHOT_AT_KEY = 'bank_v4_lastgood_at';

/* while true the store on screen is NOT what is on the device, so
   nothing may be written over it until the user decides */
let recoveryMode = false;
/* things that were repaired or dropped while reading a file that did parse */
let dataIssues = [];

/* Does this look like a tracker at all? Deliberately loose — it only
   has to rule out "valid JSON, but nothing to do with this app",
   which is what used to slip through into an empty screen. */
function looksLikeStore(d) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
    if (d.accounts && typeof d.accounts === 'object' && !Array.isArray(d.accounts)) {
        return ACCOUNT_KEYS.some(k => d.accounts[k] && typeof d.accounts[k] === 'object');
    }
    /* the older single-account shape, and the shape a backup file has */
    return Array.isArray(d.categories) || Array.isArray(d.moneyIn);
}

/* Walk what did parse and note anything that had to be thrown away,
   so a half-damaged file reports what was lost instead of quietly
   losing it. */
function auditStore(d) {
    const issues = [];
    const accts = (d && d.accounts) || {};
    ACCOUNT_KEYS.forEach(key => {
        const a = accts[key];
        if (a === undefined) return;
        const label = (d.settings && d.settings.labels && d.settings.labels[key]) || DEFAULT_SETTINGS.labels[key] || key;
        if (!a || typeof a !== 'object' || Array.isArray(a)) {
            issues.push('the ' + label + ' account could not be read at all');
            return;
        }
        if (a.categories !== undefined && !Array.isArray(a.categories)) {
            issues.push('the categories in ' + label + ' were not a list, so none could be read');
        } else {
            const bad = (a.categories || []).filter(c => !c || typeof c !== 'object' || typeof c.name !== 'string').length;
            if (bad) issues.push(bad + ' categor' + (bad === 1 ? 'y was' : 'ies were') + ' damaged in ' + label);
            let badExp = 0;
            (a.categories || []).forEach(c => {
                if (!c || !Array.isArray(c.expenses)) { if (c && c.expenses !== undefined) badExp++; return }
                badExp += c.expenses.filter(e => !e || isNaN(Number(e.amount))).length;
            });
            if (badExp) issues.push(badExp + ' entr' + (badExp === 1 ? 'y' : 'ies') + ' in ' + label + ' had no usable amount');
        }
        if (a.moneyIn !== undefined && !Array.isArray(a.moneyIn)) {
            issues.push('the money-added history in ' + label + ' could not be read');
        }
    });
    return issues;
}

/* toISOString() is UTC and can name the wrong day near midnight */
function localISODate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function snapshotAge() {
    const at = lsGet(SNAPSHOT_AT_KEY);
    if (!at) return null;
    const d = new Date(at);
    return isNaN(d.getTime()) ? null : d;
}
function hasSnapshot() { return !!lsGet(SNAPSHOT_KEY) && !!snapshotAge() }
/* Written from data that has just been proved readable, so the copy
   itself can never be the damaged one. */
let lastSnapshotAt = 0;
function writeSnapshot(raw) {
    if (!raw || raw.length > 2000000) return;    /* never fill the device up for this */
    const res = lsSet(SNAPSHOT_KEY, raw);
    if (res.ok) { lsSet(SNAPSHOT_AT_KEY, new Date().toISOString()); lastSnapshotAt = Date.now() }
}
function refreshSnapshot() {
    /* at most once a minute, and never while the store on screen is
       not the real one */
    if (recoveryMode || Date.now() - lastSnapshotAt < 60000) return;
    writeSnapshot(lsGet('bank_v4'));
}

function recoveryActions() {
    const snap = snapshotAge();
    return (snap
        ? '<button class="storage-btn" onclick="restoreSnapshot()">Restore the last good copy (' +
        vizEsc(isoToLabel(localISODate(snap))) + ')</button>'
        : '') +
        '<button class="storage-btn' + (snap ? ' ghost' : '') + '" onclick="openBackup()">Restore from a backup file</button>' +
        '<button class="storage-btn ghost" onclick="downloadUnreadable()">Download the damaged copy</button>' +
        '<button class="storage-btn ghost" onclick="startFresh()">Start fresh</button>';
}
function enterRecovery(raw, why) {
    recoveryMode = true;
    /* keep whatever could not be read, so nothing is thrown away */
    lsSet(UNREADABLE_KEY, raw == null ? '' : String(raw));
    window.__unreadable = raw;
    const snap = snapshotAge();
    showStorageAlert('warn', 'Your saved records could not be read',
        why + ' Your old data has <strong>not</strong> been deleted, and nothing new will be saved ' +
        'until you choose below — so the damaged copy stays exactly as it is.' +
        (snap
            ? ' There is an automatic copy from <strong>' + vizEsc(isoToLabel(localISODate(snap))) +
            '</strong> that opened cleanly.'
            : ' There is no automatic copy on this device, so a backup file is the way back.'),
        recoveryActions());
}
function exitRecovery() {
    recoveryMode = false;
    hideStorageAlert();
}
function restoreSnapshot() {
    const raw = lsGet(SNAPSHOT_KEY);
    if (!raw) { showToast('No automatic copy on this device'); return }
    let data = null;
    try { data = JSON.parse(raw) } catch (e) { data = null }
    if (!looksLikeStore(data)) { showToast('The automatic copy cannot be read either'); return }
    const snap = snapshotAge();
    if (!confirm('Restore the copy from ' + (snap ? isoToLabel(localISODate(snap)) : 'the last good open') +
        '? Anything recorded after that is not in it — the damaged copy stays downloadable either way.')) return;
    adoptStore(data);
    exitRecovery();
    if (!save()) return;
    applySettings(); syncAccountUI(); render();
    showToast('Restored from the last good copy ✓');
}
function startFresh() {
    if (!confirm('Start with an empty tracker? The damaged copy stays on this device and can still be downloaded, ' +
        'but the tracker will begin blank.')) return;
    adoptStore(null);
    exitRecovery();
    save();
    applySettings(); syncAccountUI(); render();
    showToast('Started fresh');
}
function downloadUnreadable() {
    const raw = window.__unreadable || lsGet(UNREADABLE_KEY) || '';
    if (!raw) { showToast('Nothing to download'); return }
    const blob = new Blob([raw], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = 'bank-damaged-' + todayISO() + '.json';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url) }, 2000);
    showToast('Damaged copy downloaded');
}
/* a file that did parse but lost pieces on the way in */
function reportDataIssues(issues) {
    showStorageAlert('warn', 'Some of your records could not be read',
        'The tracker opened, but parts of what was stored did not make sense and were left out: ' +
        '<strong>' + issues.map(vizEsc).join('</strong>; <strong>') + '</strong>. ' +
        'Everything readable is here. Restore a backup if this does not look right — the tracker will not ' +
        'overwrite anything until you make a change.',
        '<button class="storage-btn" onclick="openBackup()">Restore from a backup file</button>' +
        (hasSnapshot() ? '<button class="storage-btn ghost" onclick="restoreSnapshot()">Restore the last good copy</button>' : '') +
        '<button class="storage-btn ghost" onclick="hideStorageAlert()">Keep what was read</button>');
}

function load() {
    const rawV4 = lsGet('bank_v4');
    if (rawV4) {
        let data = null;
        try { data = JSON.parse(rawV4) }
        catch (e) {
            adoptStore(null);
            enterRecovery(rawV4, 'The tracker found saved data on this device but it is not readable — ' +
                'usually a save that was cut short.');
            return;
        }
        if (!looksLikeStore(data)) {
            adoptStore(null);
            enterRecovery(rawV4, 'The tracker found saved data on this device, but it is not a tracker file — ' +
                'something else has been written to the same place.');
            return;
        }
        dataIssues = auditStore(data);
        adoptStore(data);
        if (dataIssues.length) { lsSet(UNREADABLE_KEY, rawV4); window.__unreadable = rawV4; reportDataIssues(dataIssues) }
        else writeSnapshot(rawV4);
        return;
    }
    /* migrate the older single-account shape into the Bank tab */
    const legacy = lsGet('bank_v3') || lsGet('maribank_v3') || lsGet('maribank_tracker_v2') || lsGet('maribank_tracker');
    if (legacy) {
        let old = null;
        try { old = JSON.parse(legacy) } catch (e) { old = null }
        if (!old || !looksLikeStore(old)) {
            adoptStore(null);
            enterRecovery(legacy, 'The tracker found older saved data on this device but could not read it.');
            return;
        }
        adoptStore({ active: 'bank', accounts: { bank: old } });
        save();
        return;
    }
    adoptStore(null);
}
function setText(id, txt) { const el = document.getElementById(id); if (el) el.textContent = txt }
/* ── APP LOCK ──
   The PIN is never stored: only a salted hash of it, so reading the saved data
   does not reveal it. This locks the screen, not the file — the records
   themselves are still plain text on the device, which the settings text and the
   manual both say plainly. */
let pinEntry = '', pinTries = 0, hiddenSince = null, lastActivity = Date.now();
const LOCK_OPTIONS = [[30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [600, '10 minutes'], [1800, '30 minutes'], [0, 'Never']];
function lockAfterSec() {
    const v = settings().lockAfter;
    return v === 0 ? 0 : (parseInt(v) || 300);
}
function isLocked() { return document.getElementById('lockScreen').classList.contains('show') }
function noteActivity() { lastActivity = Date.now() }
['mousedown', 'mousemove', 'keydown', 'touchstart', 'scroll', 'wheel'].forEach(ev =>
    window.addEventListener(ev, noteActivity, { passive: true }));
/* leave it alone long enough and it locks itself */
setInterval(() => {
    if (!hasPin() || !lockAfterSec() || isLocked()) return;
    if (Date.now() - lastActivity >= lockAfterSec() * 1000) lockNow();
}, 2000);
function hasPin() { return !!(settings().pin && settings().pin.hash) }
function randomSalt() {
    if (window.crypto && crypto.getRandomValues) {
        const a = new Uint8Array(8); crypto.getRandomValues(a);
        return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return Math.random().toString(36).slice(2, 12);
}
async function hashPin(pin, salt) {
    const data = salt + '|' + pin;
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
        try {
            const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
            return 'sha256:' + Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) { }
    }
    let h = 5381;
    for (let i = 0; i < data.length; i++) h = ((h * 33) ^ data.charCodeAt(i)) >>> 0;
    return 'fb:' + h.toString(16);
}
async function pinMatches(pin) {
    const rec = settings().pin; if (!rec) return false;
    return (await hashPin(pin, rec.salt)) === rec.hash;
}

function renderPinDots() {
    const len = (settings().pin && settings().pin.len) || 4;
    document.getElementById('pinDots').innerHTML =
        Array.from({ length: len }, (_, i) => `<span class="pin-dot${i < pinEntry.length ? ' on' : ''}"></span>`).join('');
}
function renderKeypad() {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
    document.getElementById('keypad').innerHTML = keys.map(k => {
        if (k === '') return '<button class="key blank" disabled></button>';
        if (k === '⌫') return '<button class="key wide" onclick="pinBack();this.blur()" aria-label="Delete">⌫</button>';
        return `<button class="key" onclick="pinPress('${k}');this.blur()">${k}</button>`;
    }).join('');
}
function pinPress(d) {
    const len = (settings().pin && settings().pin.len) || 4;
    if (pinEntry.length >= len) return;
    pinEntry += d; renderPinDots();
    if (pinEntry.length === len) setTimeout(tryUnlock, 120);
}
function pinBack() { pinEntry = pinEntry.slice(0, -1); renderPinDots() }
/* on a computer the keypad is optional — the number keys just work */
document.addEventListener('keydown', e => {
    if (!isLocked() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key >= '0' && e.key <= '9') { e.preventDefault(); pinPress(e.key) }
    else if (e.key === 'Backspace') { e.preventDefault(); pinBack() }
    else if (e.key === 'Escape') { e.preventDefault(); pinEntry = ''; renderPinDots() }
});
async function tryUnlock() {
    const sub = document.getElementById('lockSub');
    if (await pinMatches(pinEntry)) {
        pinEntry = ''; pinTries = 0; noteActivity(); hiddenSince = null;
        document.getElementById('lockScreen').classList.remove('show');
        document.documentElement.classList.remove('locked-boot');
        document.getElementById('lockNote').classList.remove('show');
        sub.textContent = 'Enter your PIN'; sub.classList.remove('bad');
        return;
    }
    pinTries++;
    pinEntry = ''; renderPinDots();
    const box = document.getElementById('lockBox');
    box.classList.remove('pin-shake'); void box.offsetWidth; box.classList.add('pin-shake');
    sub.classList.add('bad');
    sub.textContent = pinTries >= 3 ? `Wrong PIN · ${pinTries} tries` : 'Wrong PIN — try again';
    if (pinTries >= 5) showLockHelp();
}
function showLockHelp() { document.getElementById('lockNote').classList.add('show') }
function lockNow() {
    if (!hasPin()) return;
    pinEntry = ''; pinTries = 0;
    document.getElementById('lockTitle').textContent = settings().appName;
    document.getElementById('lockMark').textContent = brandInitial(settings().appName);
    document.getElementById('lockSub').textContent = 'Enter your PIN';
    document.getElementById('lockSub').classList.remove('bad');
    document.getElementById('lockNote').classList.remove('show');
    renderKeypad(); renderPinDots();
    document.getElementById('lockScreen').classList.add('show');
    document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
}
/* lock again if the app sat in the background for a while */
document.addEventListener('visibilitychange', () => {
    if (!hasPin() || !lockAfterSec()) return;
    if (document.hidden) { hiddenSince = Date.now(); return }
    if (hiddenSince && Date.now() - hiddenSince >= lockAfterSec() * 1000) lockNow();
    hiddenSince = null; noteActivity();
});

/* ── setting, changing and removing the PIN ── */
let pinMode = 'set';
function renderLockSettings() {
    const on = hasPin();
    document.getElementById('lockState').innerHTML = on
        ? 'App lock is <strong>on</strong> — this tracker asks for your PIN when it opens.'
        : 'App lock is <strong>off</strong> — anyone who opens this page sees your records.';
    document.getElementById('lockButtons').innerHTML = on
        ? '<button class="storage-btn" onclick="openPinModal(\'change\')">Change PIN</button>' +
        '<button class="storage-btn ghost" onclick="openPinModal(\'off\')">Turn off lock</button>'
        : '<button class="storage-btn" onclick="openPinModal(\'set\')">Set a PIN</button>';
    const item = document.getElementById('lockMenuItem');
    if (item) item.style.display = on ? 'block' : 'none';
    const sel = document.getElementById('setLockAfter');
    if (sel) {
        const cur = lockAfterSec();
        sel.innerHTML = LOCK_OPTIONS.map(([v, label]) =>
            `<option value="${v}"${v === cur ? ' selected' : ''}>${label}${v === 0 ? ' — stay unlocked' : ' of no activity'}</option>`).join('');
    }
}
function openPinModal(mode) {
    pinMode = mode;
    const needsCurrent = mode !== 'set';
    document.getElementById('pinModalTitle').textContent =
        mode === 'set' ? 'Set a PIN' : mode === 'change' ? 'Change your PIN' : 'Turn off the lock';
    document.getElementById('pinModalHint').textContent =
        mode === 'off' ? 'Enter your PIN to switch the lock off.'
            : 'Pick 4 numbers you will remember. There is no way to reset a forgotten PIN.';
    document.getElementById('pinFieldCurrent').style.display = needsCurrent ? 'block' : 'none';
    document.getElementById('pinFieldNew').style.display = mode === 'off' ? 'none' : 'block';
    document.getElementById('pinSaveBtn').textContent = mode === 'off' ? 'Turn off lock' : 'Save PIN';
    ['pinCurrent', 'pinNew', 'pinConfirm'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('pinModal').classList.add('open');
    setTimeout(() => document.getElementById(needsCurrent ? 'pinCurrent' : 'pinNew').focus(), 100);
}
function closePinModal() { document.getElementById('pinModal').classList.remove('open') }
async function savePinModal() {
    const st = settings();
    if (pinMode !== 'set') {
        const current = document.getElementById('pinCurrent').value.trim();
        if (!(await pinMatches(current))) { showToast('That is not your current PIN'); return }
    }
    if (pinMode === 'off') {
        st.pin = null; save(); closePinModal(); renderLockSettings();
        showToast('App lock turned off'); return;
    }
    const pin = document.getElementById('pinNew').value.trim();
    const again = document.getElementById('pinConfirm').value.trim();
    if (!/^[0-9]{4}$/.test(pin)) { showToast('Your PIN must be 4 numbers'); return }
    if (pin !== again) { showToast('The two PINs do not match'); return }
    const salt = randomSalt();
    st.pin = { salt, hash: await hashPin(pin, salt), len: 4 };
    save(); closePinModal(); renderLockSettings();
    showToast(pinMode === 'change' ? 'PIN changed ✓' : 'App lock is on ✓');
}

const CURRENCY_PICKS = ['₱', '$', '€', '£', '¥', '₹', 'RM', 'Rp', '₩', 'د.إ'];
/* first letter or digit of the tracker title — what the logo mark shows */
function brandInitial(name) {
    const s = String(name == null ? '' : name).trim();
    let m = null;
    try { m = s.match(/[\p{L}\p{N}]/u) } catch (e) { m = s.match(/[A-Za-z0-9]/) }
    const ch = (m && m[0]) || s.charAt(0) || DEFAULT_SETTINGS.appName.charAt(0);
    return ch.toUpperCase();
}
function applySettings() {
    const st = settings();
    setText('headerTitle', st.appName);
    setText('headerMark', brandInitial(st.appName));
    setText('headerTagline', st.appTagline);
    document.title = st.appName + ' · ' + st.appTagline;
    document.querySelectorAll('[data-account]').forEach(b => { b.textContent = accountLabel(b.dataset.account) });
    document.querySelectorAll('[data-cur-label]').forEach(el => { el.textContent = `${el.dataset.curLabel} (${cur()})` });
    document.querySelectorAll('[data-cur-ph]').forEach(el => { el.placeholder = el.dataset.curPh.replace('{c}', cur()) });
    const dirBank = document.getElementById('dirBankCash'), dirCash = document.getElementById('dirCashBank');
    if (dirBank) dirBank.textContent = `${accountLabel('bank')} → ${accountLabel('cash')}`;
    if (dirCash) dirCash.textContent = `${accountLabel('cash')} → ${accountLabel('bank')}`;
}
function openSettings() {
    const st = settings();
    document.getElementById('setCurrency').value = st.currency;
    document.getElementById('setLabelBank').value = accountLabel('bank');
    document.getElementById('setLabelCash').value = accountLabel('cash');
    document.getElementById('setCycleStart').value = cycleStart();
    renderThemePicker(); renderAppearanceState(); renderOfflineStatus();
    document.getElementById('setAppName').value = st.appName;
    document.getElementById('setAppTagline').value = st.appTagline;
    renderLockSettings();
    document.getElementById('curPicks').innerHTML = CURRENCY_PICKS.map(c =>
        `<button type="button" class="cur-pick${c === st.currency ? ' active' : ''}" onclick="pickCurrency('${c}')">${c}</button>`).join('');
    document.getElementById('settingsModal').classList.add('open');
}
function closeSettings() { document.getElementById('settingsModal').classList.remove('open') }
function pickCurrency(c) {
    document.getElementById('setCurrency').value = c;
    document.querySelectorAll('.cur-pick').forEach(b => b.classList.toggle('active', b.textContent === c));
}
function saveSettings() {
    const st = settings();
    const currency = document.getElementById('setCurrency').value.trim();
    const bank = document.getElementById('setLabelBank').value.trim();
    const cash = document.getElementById('setLabelCash').value.trim();
    const start = parseInt(document.getElementById('setCycleStart').value);
    const appName = document.getElementById('setAppName').value.trim();
    const tagline = document.getElementById('setAppTagline').value.trim();
    if (!currency) { showToast('Enter a currency symbol'); return }
    if (!bank || !cash) { showToast('Both tabs need a name'); return }
    if (isNaN(start) || start < 1 || start > 28) { showToast('Budget month must start between 1 and 28'); return }
    st.currency = currency;
    st.labels = { bank, cash };
    st.cycleStart = start;
    st.appName = appName || DEFAULT_SETTINGS.appName;
    st.appTagline = tagline || DEFAULT_SETTINGS.appTagline;
    const lockSel = document.getElementById('setLockAfter');
    if (lockSel && lockSel.value !== '') st.lockAfter = parseInt(lockSel.value);
    noteActivity();
    save();
    activePeriod = thisPeriod();
    applySettings(); applyAppearance(); syncAccountUI(); render();
    closeSettings();
    showToast('Settings saved ✓');
}

function syncAccountUI() {
    const L = activeLabel();
    applySettings();
    document.querySelectorAll('.account-tab').forEach(b => b.classList.toggle('active', b.dataset.account === store.active));
    setText('eyebrowAccount', L);
    setText('remainingLabel', L);
    setText('addMoneyTitle', 'Add Money · ' + L);
    setText('reportTitle', 'Monthly Report · ' + L);
    setText('logsTitle', 'All Logs · ' + L);
    setText('goalsTitle', 'Savings Goals · ' + L);
    setText('resetMenuItem', 'Reset ' + L + ' Data');
}
function setAccount(key) {
    if (ACCOUNT_KEYS.indexOf(key) < 0 || store.active === key) return;
    store.active = key; state = store.accounts[key]; save();
    syncAccountUI(); closeDataMenu();
    logsFilter = 'all';
    render();
    /* keep whatever is typed and selected — only the account changed */
    if (logsIsOpen()) refreshLogs();
    if (document.getElementById('reportModal').classList.contains('open')) buildReport();
    if (document.getElementById('addMoneyModal').classList.contains('open')) renderMoneyHistory();
    showToast('Switched to ' + activeLabel());
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }
function fmt(n) {
    const v = Number(n) || 0;
    const digits = Math.abs(v).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '−' : '') + cur() + digits;
}
function todayISO() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function isoToLabel(iso) { const [y, m, d] = iso.split('-'); return `${MONTHS_SHORT[parseInt(m) - 1]} ${parseInt(d)}, ${y}` }
function isoToMonthKey(iso) { return iso ? iso.slice(0, 7) : '0000-00' }
function labelToISO(label) {
    if (!label) return '';
    const parts = String(label).replace(',', '').split(' '); const mi = MONTHS_SHORT.indexOf(parts[0]);
    if (mi < 0 || parts.length < 3) return '';
    return `${parts[2]}-${String(mi + 1).padStart(2, '0')}-${String(parts[1]).padStart(2, '0')}`;
}
function fmtLogDate(e) {
    if (e.dateRaw) { const [y, m, d] = e.dateRaw.split('-'); return `${m}/${d}/${y.slice(2)}` }
    if (e.date) { const parts = e.date.replace(',', '').split(' '); const mi = MONTHS_SHORT.indexOf(parts[0]); if (mi >= 0) { const m = String(mi + 1).padStart(2, '0'); const d = String(parts[1]).padStart(2, '0'); const y = parts[2] ? parts[2].slice(2) : '??'; return `${m}/${d}/${y}` } }
    return '—'
}
function fmtLogTime(e) {
    if (e.loggedAt) { const d = new Date(e.loggedAt); let h = d.getHours(), min = d.getMinutes(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')} ${ampm}` }
    return null
}
function expType(e) { return e.type || 'spent' }

/* ── MONTHLY BUDGET CYCLE ──
   Category budgets run per calendar month. cat.budget is the default monthly
   allowance and cat.periods['YYYY-MM'] overrides it for a single month. */
/* A budget month normally follows the calendar, but Settings can start it on
   any day up to the 28th — payday budgeting. The key stays 'YYYY-MM' of the
   month the cycle opens in, so months still sort and step the same way. */
function periodKeyFromISO(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const cs = cycleStart();
    if (cs === 1 || d >= cs) return `${y}-${String(m).padStart(2, '0')}`;
    const prev = new Date(y, m - 2, 1);
    return `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
}
let activePeriod = todayISO().slice(0, 7);
function thisPeriod() { return periodKeyFromISO(todayISO()) }
function periodStartISO(key) {
    const [y, m] = key.split('-').map(Number);
    return `${y}-${String(m).padStart(2, '0')}-${String(cycleStart()).padStart(2, '0')}`;
}
function periodLabel(key) {
    const [y, m] = key.split('-').map(Number);
    const cs = cycleStart();
    if (cs === 1) return `${MONTHS_FULL[m - 1]} ${y}`;
    const endBase = new Date(y, m, 1);
    const lastDay = new Date(endBase.getFullYear(), endBase.getMonth() + 1, 0).getDate();
    const endDay = Math.min(cs - 1, lastDay);
    return `${MONTHS_SHORT[m - 1]} ${cs} – ${MONTHS_SHORT[endBase.getMonth()]} ${endDay}, ${endBase.getFullYear()}`;
}
function shiftPeriod(key, delta) {
    const [y, m] = key.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function periodOf(e) {
    if (e.dateRaw) return periodKeyFromISO(e.dateRaw);
    const k = parseFallbackKey(e.date);
    if (k && k !== '0000-00') return k;
    if (e.loggedAt) { const d = new Date(e.loggedAt); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }
    return '0000-00';
}
function expensesIn(cat, period) { return (cat.expenses || []).filter(e => periodOf(e) === period) }
function catSpentOnly(cat, period) { return expensesIn(cat, period || activePeriod).filter(e => expType(e) === 'spent').reduce((s, e) => s + Number(e.amount), 0) }
function catLoanOnly(cat, period) { return expensesIn(cat, period || activePeriod).filter(e => expType(e) === 'loan').reduce((s, e) => s + Number(e.amount), 0) }
function catSpent(cat, period) { return expensesIn(cat, period || activePeriod).reduce((s, e) => s + Number(e.amount), 0) }
function catSpentAllTime(cat) { return (cat.expenses || []).reduce((s, e) => s + Number(e.amount), 0) }
function totalSpentAll() { return state.categories.reduce((s, c) => s + catSpentAllTime(c), 0) }
function monthSpentAll(period) { return state.categories.reduce((s, c) => s + catSpent(c, period || activePeriod), 0) }

/* the plain allowance for a month, before any carried-over balance */
function baseBudget(cat, period) {
    const key = period || activePeriod;
    const o = cat.periods && cat.periods[key];
    return o === undefined || o === null ? (Number(cat.budget) || 0) : (Number(o) || 0);
}
function setBaseBudget(cat, period, amount) {
    if (!cat.periods) cat.periods = {};
    cat.periods[period] = Math.max(0, Number(amount) || 0);
}
function catBudget(cat, period) { return baseBudget(cat, period) }
function catTotalBudget(period) { return state.categories.reduce((s, c) => s + catBudget(c, period), 0) }
function catTotalRem() { return state.categories.reduce((s, c) => s + Math.max(0, catBudget(c) - catSpent(c)), 0) }
function isDepleted(cat, period) { const b = catBudget(cat, period); return b > 0 && catSpent(cat, period) >= b }
/* everything one category card needs, for the month on screen */
function catStats(cat) {
    const budget = catBudget(cat), spent = catSpent(cat);
    const rem = budget - spent;
    return {
        budget, spent, rem,
        pct: budget > 0 ? Math.min((spent / budget) * 100, 100) : 0,
        depleted: budget > 0 && spent >= budget
    };
}

function renderPeriodBar() {
    const isThis = activePeriod === thisPeriod();
    document.getElementById('periodLabel').textContent = periodLabel(activePeriod) + (isThis ? ' · this month' : '');
    const spent = monthSpentAll(), budgeted = catTotalBudget(activePeriod);
    document.getElementById('periodSub').textContent = valuesHidden
        ? mask() + ' spent of ' + mask()
        : `${fmt(spent)} spent of ${fmt(budgeted)} budgeted`;
    document.getElementById('periodBar').classList.toggle('past', !isThis);
    document.getElementById('periodToday').classList.toggle('show', !isThis);
}
function setPeriod(key) {
    activePeriod = key;
    render();
    if (logsIsOpen()) refreshLogs();
}
function stepPeriod(delta) { setPeriod(shiftPeriod(activePeriod, delta)) }
function goToThisMonth() { setPeriod(thisPeriod()) }
/* a sensible default date for a new expense in the month being viewed */
function periodDefaultDate() {
    return activePeriod === thisPeriod() ? todayISO() : periodStartISO(activePeriod);
}
function parseFallbackKey(dateStr) {
    if (!dateStr) return '0000-00'; const parts = dateStr.replace(',', '').split(' ');
    if (parts.length < 3) return '0000-00';
    return `${parts[2]}-${String(MONTHS_SHORT.indexOf(parts[0]) + 1).padStart(2, '0')}`;
}

function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg; t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2400);
}

// ── SAVE-YOUR-DATA REMINDERS ──
const NOTICE_KEY = 'bank_notice_seen';
function dismissNotice() {
    lsSet(NOTICE_KEY, '1');
    document.getElementById('dataNotice').classList.remove('show');
}
function maybeShowNotice() {
    if (lsGet(NOTICE_KEY) !== '1') document.getElementById('dataNotice').classList.add('show');
}
function renderBackupAge() {
    const el = document.getElementById('backupAge'); if (!el) return;
    const at = store.lastBackupAt;
    if (!at) { el.textContent = 'Last backup: never — a good time to save one'; el.className = 'backup-age stale'; return }
    const d = new Date(at); const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    const when = d.toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' });
    el.textContent = days <= 0 ? `Last backup: today (${when})`
        : days === 1 ? `Last backup: yesterday (${when})`
            : `Last backup: ${days} days ago (${when})`;
    el.className = 'backup-age' + (days >= 14 ? ' stale' : '');
}

// ── USER MANUAL ──
function openManual() { document.getElementById('manualModal').classList.add('open') }
function closeManual() { document.getElementById('manualModal').classList.remove('open') }

// ── ADD MONEY ──
function openAddMoney() {
    document.getElementById('addMoneyNote').value = '';
    document.getElementById('addMoneyAmount').value = '';
    document.getElementById('addMoneyDate').value = todayISO();
    renderMoneyHistory();
    document.getElementById('addMoneyModal').classList.add('open');
    setTimeout(() => document.getElementById('addMoneyNote').focus(), 100);
}

function closeAddMoney() {
    document.getElementById('addMoneyModal').classList.remove('open');
}

function saveAddMoney() {
    const note = document.getElementById('addMoneyNote').value.trim();
    const amount = parseFloat(document.getElementById('addMoneyAmount').value);
    const dateISO = document.getElementById('addMoneyDate').value;
    if (!note) { showToast('Add a note/source'); return }
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    if (!dateISO) { showToast('Pick a date'); return }
    if (!state.moneyIn) state.moneyIn = [];
    const entry = { id: uid(), note, amount, dateRaw: dateISO, date: isoToLabel(dateISO), loggedAt: Date.now() };
    state.moneyIn.unshift(entry);
    state.totalBudget = (Number(state.totalBudget) || 0) + amount;
    save();
    document.getElementById('addMoneyAmount').value = '';
    document.getElementById('addMoneyNote').value = '';
    renderMoneyHistory();
    renderBudgetCard();
    showToast(`+${fmt(amount)} added to budget`);
}

function deleteMoneyIn(id) {
    const entry = (state.moneyIn || []).find(e => e.id === id);
    if (!entry) return;
    if (isTransfer(entry)) {
        const partner = transferPartner(entry);
        if (!confirm(`Undo this transfer of ${fmt(entry.amount)}? It will be removed from both the Bank and Cash tabs.`)) return;
        const amt = Number(entry.amount);
        const here = store.accounts[store.active], there = store.accounts[entry.other];
        here.totalBudget = (Number(here.totalBudget) || 0) + (entry.dir === 'out' ? amt : -amt);
        here.moneyIn = (here.moneyIn || []).filter(e => e.id !== id);
        if (partner && there) {
            there.totalBudget = (Number(there.totalBudget) || 0) + (partner.dir === 'out' ? amt : -amt);
            there.moneyIn = (there.moneyIn || []).filter(e => e.linkId !== entry.linkId);
        }
        save(); renderMoneyHistory(); renderBudgetCard();
        showToast('Transfer undone'); return;
    }
    if (isSetAside(entry)) {
        const goal = findGoalById(entry.goalId);
        if (!confirm(`Take back ${fmt(entry.amount)} set aside${goal ? ' for ' + goal.name : ''}? It goes back into your excess.`)) return;
        state.totalBudget = (Number(state.totalBudget) || 0) + Number(entry.amount);
        state.moneyIn = (state.moneyIn || []).filter(e => e.id !== id);
        save(); renderMoneyHistory(); renderBudgetCard(); renderGoalBadge();
        if (goalsIsOpen()) renderGoals();
        showToast('Put back into your excess'); return;
    }
    if (!confirm(`Remove "${entry.note}" (${fmt(entry.amount)}) from budget history?`)) return;
    state.totalBudget = Math.max(0, (Number(state.totalBudget) || 0) - Number(entry.amount));
    state.moneyIn = (state.moneyIn || []).filter(e => e.id !== id);
    save();
    renderMoneyHistory();
    renderBudgetCard();
    showToast('Entry removed');
}

/* ── LOANS YOU ARE PAYING OFF ──
   A loan is a debt: a name, who it is with, and the total to be paid. Expenses
   logged as type 'loan' carry loanId, so each payment counts towards its loan.
   Money never comes back — a payment is spending like any other. */
function isLoanExp(e) { return expType(e) === 'loan' }
function loanList() { return state.loans || (state.loans = []) }
function findLoanById(id) { return loanList().find(l => l.id === id) || null }
function loanPayments(loanId) {
    const out = [];
    state.categories.forEach(cat => (cat.expenses || []).forEach(e => {
        if (isLoanExp(e) && e.loanId === loanId) out.push({ e, cat });
    }));
    return out.sort((a, b) => String(b.e.dateRaw || '').localeCompare(String(a.e.dateRaw || '')));
}
function loanPaid(loan) { return loanPayments(loan.id).reduce((s, x) => s + Number(x.e.amount), 0) }
function loanLeft(loan) { return Math.max(0, (Number(loan.principal) || 0) - loanPaid(loan)) }
function loanDone(loan) { return (Number(loan.principal) || 0) > 0 && loanLeft(loan) <= 0.005 }
function ordinal(n) {
    const t = n % 100;
    if (t >= 11 && t <= 13) return n + 'th';
    return n + (n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');
}
/* has a payment been logged against this loan in the current calendar month? */
function loanPaidThisMonth(loan) { return loanPayments(loan.id).some(x => periodOf(x.e) === thisPeriod()) }
/* days from today to this month's payment day (negative once it has passed) */
function daysToDueDay(loan) {
    const day = parseInt(loan.dueDay); if (isNaN(day)) return null;
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return Math.min(day, lastDay) - now.getDate();
}
function loanStatus(loan) {
    if (loanDone(loan)) return { label: 'Paid off', cls: ' settled', card: ' settled' };
    if (loanPaidThisMonth(loan)) return { label: 'Paid this month', cls: ' settled', card: '' };
    const days = daysToDueDay(loan);
    if (days === null) return { label: 'Active', cls: '', card: '' };
    if (days < 0) return { label: `Overdue — was due the ${ordinal(parseInt(loan.dueDay))}`, cls: ' overdue', card: ' overdue' };
    if (days === 0) return { label: 'Due today', cls: ' warn', card: ' due-soon' };
    if (days <= 7) return { label: `Due in ${days} day${days === 1 ? '' : 's'}`, cls: ' warn', card: ' due-soon' };
    return { label: `Due on the ${ordinal(parseInt(loan.dueDay))}`, cls: '', card: '' };
}
/* 'overdue' | 'today' | 'soon' | null — how urgent this loan's next payment is */
function loanUrgency(loan) {
    if (loanDone(loan) || loanPaidThisMonth(loan)) return null;
    const days = daysToDueDay(loan);
    if (days === null) return null;
    if (days < 0) return 'overdue';
    if (days === 0) return 'today';
    if (days <= 7) return 'soon';
    return null;
}
function loanNeedsAttention(loan) { return loanUrgency(loan) !== null }
/* worst urgency across every loan — drives the Loans button highlight */
function loansAlertLevel() {
    let lvl = null;
    loanList().forEach(l => {
        const u = loanUrgency(l);
        if (u === 'overdue') lvl = 'overdue';
        else if (u === 'today' && lvl !== 'overdue') lvl = 'today';
        else if (u === 'soon' && !lvl) lvl = 'soon';
    });
    return lvl;
}
function loansDueCount() { return loanList().filter(loanNeedsAttention).length }
function renderLoanBadge() {
    const btn = document.getElementById('btnLoans'); if (!btn) return;
    const n = loansDueCount();
    const badge = document.getElementById('loansBadge');
    if (badge) badge.remove();
    const lvl = loansAlertLevel();
    btn.classList.toggle('due', lvl === 'soon');
    btn.classList.toggle('overdue-alert', lvl === 'overdue');
    btn.classList.toggle('due-today-alert', lvl === 'today');
    if (lvl === 'overdue') btn.title = n === 1 ? 'A loan payment is overdue' : 'You have overdue loan payments';
    else if (lvl === 'today') btn.title = 'A loan payment is due today';
    else if (lvl === 'soon') btn.title = 'A loan payment is due within a week';
    else btn.removeAttribute('title');
    if (n > 0) btn.insertAdjacentHTML('beforeend', `<span class="loan-badge" id="loansBadge">${n}</span>`);
}
function loansLeftTotal() { return loanList().reduce((s, l) => s + loanLeft(l), 0) }
function loansPaidTotal() { return loanList().reduce((s, l) => s + loanPaid(l), 0) }
function unassignedLoanPayments() {
    const out = [];
    state.categories.forEach(cat => (cat.expenses || []).forEach(e => {
        if (isLoanExp(e) && !findLoanById(e.loanId)) out.push({ e, cat });
    }));
    return out;
}
function loanOptionsHtml(selectedId) {
    const opts = loanList().map(l =>
        `<option value="${l.id}"${l.id === selectedId ? ' selected' : ''}>${l.name}${loanDone(l) ? ' (paid off)' : ''}</option>`).join('');
    return `<option value=""${selectedId ? '' : ' selected'}>Not linked to a loan</option>${opts}`;
}
function refreshLoanSelects() {
    state.categories.forEach(cat => {
        const el = document.getElementById('loanPick_' + cat.id);
        if (el) { const cur = el.value; el.innerHTML = loanOptionsHtml(cur); el.value = cur }
    });
}

/* ── the Loans screen ── */
let loansFilter = 'open';
function openLoans() {
    setLoansFilter('open');
    document.getElementById('loansTitle').textContent = 'Loans · ' + activeLabel();
    document.getElementById('loansModal').classList.add('open');
}
function closeLoans() { document.getElementById('loansModal').classList.remove('open') }
function setLoansFilter(f) {
    loansFilter = f;
    ['loanFilterOpen', 'loanFilterSettled', 'loanFilterAll'].forEach(id => document.getElementById(id).classList.remove('active'));
    document.getElementById(f === 'open' ? 'loanFilterOpen' : f === 'settled' ? 'loanFilterSettled' : 'loanFilterAll').classList.add('active');
    renderLoans();
}
function renderLoans() {
    document.getElementById('loansOwed').textContent = valuesHidden ? mask() : fmt(loansLeftTotal());
    document.getElementById('loansRepaid').textContent = valuesHidden ? mask() : fmt(loansPaidTotal());
    const list = document.getElementById('loansList');
    const rows = loanList().filter(l => loansFilter === 'all' ? true : loansFilter === 'settled' ? loanDone(l) : !loanDone(l));
    let html = '';
    if (!rows.length) {
        html = `<div class="loans-empty">${loansFilter === 'settled' ? 'Nothing paid off yet.' : loansFilter === 'open' ? 'No active loans. Add one to start tracking what you still owe.' : 'No loans yet. Add the loans you are paying off, then log each payment as a Loan expense.'}</div>`;
    } else {
        html = rows.map(l => {
            const paid = loanPaid(l), left = loanLeft(l), total = Number(l.principal) || 0;
            const pct = total > 0 ? Math.min((paid / total) * 100, 100) : 0;
            const st = loanStatus(l);
            const pays = loanPayments(l.id);
            const payHtml = pays.length ? `<div class="loan-payments">${pays.slice(0, 6).map(x =>
                `<div class="loan-payment"><span>${x.e.date} · ${x.cat.name}</span><span>${fmt(x.e.amount)}</span></div>`).join('')}${pays.length > 6 ? `<div class="loan-payment"><span>+ ${pays.length - 6} earlier payment${pays.length - 6 === 1 ? '' : 's'}</span><span></span></div>` : ''}</div>` : '';
            return `<div class="loan-card${st.card}">
                <div class="loan-card-top">
                    <div style="min-width:0">
                        <div class="loan-who">${l.name} <span class="loan-status${st.cls}">${st.label}</span></div>
                        <div class="loan-meta">${l.lender ? l.lender + ' · ' : ''}${pays.length} payment${pays.length === 1 ? '' : 's'}${l.monthly ? ' · ' + fmt(l.monthly) + ' a month' : ''}${l.dueDay && !loanDone(l) ? ' · due every ' + ordinal(parseInt(l.dueDay)) : ''}</div>
                    </div>
                    <div class="loan-amounts">
                        <span class="loan-out">${loanDone(l) ? fmt(total) : fmt(left)}</span>
                        <span class="loan-of">${loanDone(l) ? 'fully paid' : 'left of ' + fmt(total)}</span>
                    </div>
                </div>
                <div class="loan-progress"><div class="loan-progress-fill${loanDone(l) ? ' done' : ''}" style="width:${pct}%"></div></div>
                <div class="loan-progress-meta"><span>${fmt(paid)} paid</span><span>${pct.toFixed(0)}%</span></div>
                ${payHtml}
                <div class="loan-actions">
                    <button class="loan-btn ghost" onclick="openLoanForm('${l.id}')">Edit</button>
                    <button class="loan-btn ghost" onclick="deleteLoan('${l.id}')">Delete</button>
                </div>
            </div>`;
        }).join('');
    }
    const loose = unassignedLoanPayments();
    if (loose.length) {
        const total = loose.reduce((s, x) => s + Number(x.e.amount), 0);
        html += `<div class="loan-card">
            <div class="loan-card-top">
                <div style="min-width:0">
                    <div class="loan-who">Loan payments not linked yet</div>
                    <div class="loan-meta">${loose.length} payment${loose.length === 1 ? '' : 's'} logged as Loan without a loan chosen. Edit a payment to link it.</div>
                </div>
                <div class="loan-amounts"><span class="loan-out">${fmt(total)}</span><span class="loan-of">total</span></div>
            </div>
        </div>`;
    }
    list.innerHTML = html;
}

/* ── add / edit a loan ── */
let editingLoanId = null;
function openLoanForm(id) {
    editingLoanId = id || null;
    const l = id ? findLoanById(id) : null;
    document.getElementById('loanFormTitle').textContent = l ? 'Edit loan' : 'Add a loan';
    document.getElementById('loanName').value = l ? l.name : '';
    document.getElementById('loanLender').value = l && l.lender ? l.lender : '';
    document.getElementById('loanPrincipal').value = l ? l.principal : '';
    document.getElementById('loanMonthly').value = l && l.monthly ? l.monthly : '';
    document.getElementById('loanDueDay').value = l && l.dueDay ? l.dueDay : '';
    document.getElementById('loanFormModal').classList.add('open');
    setTimeout(() => document.getElementById('loanName').focus(), 100);
}
function closeLoanForm() { document.getElementById('loanFormModal').classList.remove('open'); editingLoanId = null }
function saveLoanForm() {
    const name = document.getElementById('loanName').value.trim();
    const lender = document.getElementById('loanLender').value.trim();
    const principal = parseFloat(document.getElementById('loanPrincipal').value);
    const monthlyRaw = document.getElementById('loanMonthly').value;
    const dueDay = parseInt(document.getElementById('loanDueDay').value);
    if (!name) { showToast('Give the loan a name'); return }
    if (isNaN(principal) || principal <= 0) { showToast('Enter the total amount to pay'); return }
    if (isNaN(dueDay) || dueDay < 1 || dueDay > 31) { showToast('Enter the payment day (1–31)'); return }
    const monthly = monthlyRaw === '' ? null : parseFloat(monthlyRaw);
    if (editingLoanId) {
        const l = findLoanById(editingLoanId); if (!l) return;
        l.name = name; l.lender = lender; l.principal = principal; l.monthly = monthly; l.dueDay = dueDay;
        delete l.dueRaw;
    } else {
        loanList().unshift({ id: uid(), name, lender, principal, monthly, dueDay, createdAt: Date.now() });
    }
    save(); closeLoanForm(); refreshLoanSelects(); renderLoanBadge();
    if (document.getElementById('loansModal').classList.contains('open')) renderLoans();
    if (document.getElementById('editExpModal').classList.contains('open')) {
        const sel = document.getElementById('editLoanPick');
        if (sel) { const cur = sel.value; sel.innerHTML = loanOptionsHtml(cur); sel.value = cur }
    }
    showToast(editingLoanId ? 'Loan updated ✓' : `${name} added ✓`);
}
function deleteLoan(id) {
    const l = findLoanById(id); if (!l) return;
    const pays = loanPayments(id);
    const msg = pays.length
        ? `Delete "${l.name}"? Its ${pays.length} payment${pays.length === 1 ? '' : 's'} stay in your records as spending, but will no longer be linked to a loan.`
        : `Delete "${l.name}"?`;
    if (!confirm(msg)) return;
    state.categories.forEach(cat => (cat.expenses || []).forEach(e => { if (e.loanId === id) delete e.loanId }));
    state.loans = loanList().filter(x => x.id !== id);
    save(); render(); renderLoans(); refreshLoanSelects();
    showToast('Loan deleted');
}

/* ── TRANSFERS ──
   A transfer is one linked pair of entries: an 'out' on the source account and
   an 'in' on the destination, sharing a linkId so edits and deletions stay in
   step. Transfers move the balance only — they are never income or spending. */
let transferFrom = 'bank';
function isTransfer(e) { return e && e.kind === 'transfer' }
/* Money set aside into a savings goal straight from the excess — it never
   belonged to a category, so it is recorded here rather than as spending.
   Like a transfer it leaves the account, so it lowers the total budget. */
function isSetAside(e) { return !!e && e.kind === 'saving' }
/* every moneyIn row that is really money leaving, whichever kind it is */
function isOutflowEntry(e) { return isTransfer(e) || isSetAside(e) }
function acctSpentAll(key) {
    return (store.accounts[key].categories || []).reduce((s, c) => s + (c.expenses || []).reduce((t, e) => t + Number(e.amount), 0), 0);
}
function acctBalance(key) { return (Number(store.accounts[key].totalBudget) || 0) - acctSpentAll(key) }
function transferTo() { return transferFrom === 'bank' ? 'cash' : 'bank' }
function setTransferDir(from) {
    transferFrom = from;
    document.getElementById('dirBankCash').className = 'log-type-btn' + (from === 'bank' ? ' active-spent' : '');
    document.getElementById('dirCashBank').className = 'log-type-btn' + (from === 'cash' ? ' active-spent' : '');
    updateTransferHint();
}
function updateTransferHint() {
    const amt = parseFloat(document.getElementById('transferAmount').value) || 0;
    const from = transferFrom, to = transferTo();
    const after = acctBalance(from) - amt;
    const el = document.getElementById('transferHint');
    el.textContent = `${accountLabel(from)} after: ${fmt(after)} · ${accountLabel(to)} after: ${fmt(acctBalance(to) + amt)}`;
    el.classList.toggle('warn', after < 0);
    if (after < 0) el.textContent += ` — this leaves ${accountLabel(from)} in the negative`;
}
function openTransfer() {
    setTransferDir(store.active === 'cash' ? 'cash' : 'bank');
    document.getElementById('transferAmount').value = '';
    document.getElementById('transferNote').value = '';
    document.getElementById('transferDate').value = todayISO();
    updateTransferHint();
    document.getElementById('transferModal').classList.add('open');
    setTimeout(() => document.getElementById('transferAmount').focus(), 100);
}
function closeTransfer() { document.getElementById('transferModal').classList.remove('open') }
function saveTransfer() {
    const amount = parseFloat(document.getElementById('transferAmount').value);
    const dateISO = document.getElementById('transferDate').value;
    const typed = document.getElementById('transferNote').value.trim();
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    if (!dateISO) { showToast('Pick a date'); return }
    const from = transferFrom, to = transferTo();
    const src = store.accounts[from], dst = store.accounts[to];
    const linkId = uid(), when = Date.now(), label = isoToLabel(dateISO);
    if (!src.moneyIn) src.moneyIn = [];
    if (!dst.moneyIn) dst.moneyIn = [];
    src.moneyIn.unshift({
        id: uid(), note: typed || `Transfer to ${accountLabel(to)}`, amount, dateRaw: dateISO, date: label,
        loggedAt: when, kind: 'transfer', dir: 'out', other: to, linkId
    });
    dst.moneyIn.unshift({
        id: uid(), note: typed || `Transfer from ${accountLabel(from)}`, amount, dateRaw: dateISO, date: label,
        loggedAt: when, kind: 'transfer', dir: 'in', other: from, linkId
    });
    src.totalBudget = (Number(src.totalBudget) || 0) - amount;
    dst.totalBudget = (Number(dst.totalBudget) || 0) + amount;
    save(); closeTransfer(); render();
    if (document.getElementById('addMoneyModal').classList.contains('open')) renderMoneyHistory();
    if (document.getElementById('reportModal').classList.contains('open')) buildReport();
    showToast(`${fmt(amount)} moved ${accountLabel(from)} → ${accountLabel(to)}`);
}
/* the matching half of a transfer, on the other account */
function transferPartner(entry) {
    if (!isTransfer(entry) || !entry.linkId) return null;
    const other = store.accounts[entry.other];
    if (!other) return null;
    return (other.moneyIn || []).find(e => e.linkId === entry.linkId) || null;
}

let editingMoneyId = null;
function editMoneyIn(id) {
    const entry = (state.moneyIn || []).find(e => e.id === id); if (!entry) return;
    editingMoneyId = id;
    document.getElementById('editMoneyNote').value = entry.note;
    document.getElementById('editMoneyAmount').value = entry.amount;
    document.getElementById('editMoneyDate').value = entry.dateRaw || labelToISO(entry.date) || todayISO();
    document.getElementById('editMoneyModal').classList.add('open');
    setTimeout(() => document.getElementById('editMoneyNote').focus(), 100);
}
function closeEditMoney() { document.getElementById('editMoneyModal').classList.remove('open'); editingMoneyId = null }
function saveEditMoney() {
    const entry = (state.moneyIn || []).find(e => e.id === editingMoneyId); if (!entry) return;
    const note = document.getElementById('editMoneyNote').value.trim();
    const amount = parseFloat(document.getElementById('editMoneyAmount').value);
    const dateISO = document.getElementById('editMoneyDate').value;
    if (!note) { showToast('Add a note/source'); return }
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    if (!dateISO) { showToast('Pick a date'); return }
    const delta = amount - Number(entry.amount);
    entry.note = note; entry.amount = amount; entry.dateRaw = dateISO; entry.date = isoToLabel(dateISO);
    if (isTransfer(entry)) {
        const here = store.accounts[store.active];
        here.totalBudget = (Number(here.totalBudget) || 0) + (entry.dir === 'out' ? -delta : delta);
        const partner = transferPartner(entry), there = store.accounts[entry.other];
        if (partner && there) {
            partner.amount = amount; partner.dateRaw = dateISO; partner.date = entry.date;
            there.totalBudget = (Number(there.totalBudget) || 0) + (partner.dir === 'out' ? -delta : delta);
        }
    } else if (isSetAside(entry)) {
        /* setting more aside takes more out of the account */
        state.totalBudget = (Number(state.totalBudget) || 0) - delta;
    } else {
        state.totalBudget = Math.max(0, (Number(state.totalBudget) || 0) + delta);
    }
    save(); closeEditMoney(); renderMoneyHistory(); renderBudgetCard(); renderGoalBadge();
    if (goalsIsOpen()) renderGoals();
    if (document.getElementById('reportModal').classList.contains('open')) buildReport();
    showToast('Entry updated ✓');
}

function renderMoneyHistory() {
    const list = document.getElementById('moneyHistoryList');
    const entries = state.moneyIn || [];
    if (entries.length === 0) {
        list.innerHTML = '<div class="no-money-history">No money added yet</div>';
        return;
    }
    list.innerHTML = entries.map(e => `
        <div class="money-history-item">
            <div class="money-history-info">
                <span class="money-history-note">${e.note}</span>
                <span class="money-history-date">${e.date}</span>
            </div>
            <span class="mh-chip${isOutflowEntry(e) ? ' transfer' : ''}">${isSetAside(e) ? 'Saved' : isTransfer(e) ? (e.dir === 'out' ? 'Out' : 'In') : 'In'}</span>
            <span class="money-history-amount${isOutflowEntry(e) && e.dir === 'out' ? ' out' : ''}">${isOutflowEntry(e) && e.dir === 'out' ? '−' : '+'}${fmt(e.amount)}</span>
            <button class="btn-edit-money" onclick="editMoneyIn('${e.id}')"
                title="Edit" aria-label="Edit ${vizEsc(e.note)}, ${vizEsc(fmt(e.amount))}">✎</button>
            <button class="btn-del-money" onclick="deleteMoneyIn('${e.id}')"
                title="Remove" aria-label="Remove ${vizEsc(e.note)}, ${vizEsc(fmt(e.amount))}">×</button>
        </div>
    `).join('');
}

document.getElementById('addMoneyAmount').addEventListener('keydown', e => {
    if (e.key === 'Enter') saveAddMoney();
});

function toggleAddForm() {
    const f = document.getElementById('addCatForm'); f.classList.toggle('open');
    if (f.classList.contains('open')) document.getElementById('newCatName').focus();
}

function addCategory() {
    const name = document.getElementById('newCatName').value.trim();
    const budget = parseFloat(document.getElementById('newCatBudget').value);
    if (!name) { showToast('Enter a category name'); return }
    if (isNaN(budget) || budget < 0) { showToast('Enter a valid budget'); return }
    state.categories.push({ id: uid(), name, budget, expenses: [], periods: {}, createdPeriod: activePeriod }); save();
    document.getElementById('newCatName').value = ''; document.getElementById('newCatBudget').value = '';
    document.getElementById('addCatForm').classList.remove('open');
    render(); showToast(`${name} added`);
}

function setLogType(catId, type, el) {
    document.querySelectorAll(`[data-type-group="${catId}"]`).forEach(b => { b.removeAttribute('data-active-type'); b.className = 'log-type-btn' });
    el.setAttribute('data-active-type', catId); el.dataset.type = type;
    el.className = 'log-type-btn ' + (type === 'spent' ? 'active-spent' : 'active-loan');
    const extra = document.getElementById('loanExtra_' + catId);
    if (extra) extra.classList.toggle('show', type === 'loan');
}

function logExpense(catId) {
    const noteEl = document.getElementById('expNote_' + catId);
    const amtEl = document.getElementById('expAmt_' + catId);
    const dateEl = document.getElementById('expDate_' + catId);
    const typeBtn = document.querySelector(`[data-active-type="${catId}"]`);
    const note = noteEl.value.trim(); const amount = parseFloat(amtEl.value);
    const dateISO = dateEl.value; const type = typeBtn ? typeBtn.dataset.type : 'spent';
    if (!note) { showToast('Add a note'); return }
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    if (!dateISO) { showToast('Pick a date'); return }
    const cat = state.categories.find(c => c.id === catId); if (!cat) return;
    const entry = { id: uid(), note, amount, type, date: isoToLabel(dateISO), dateRaw: dateISO, loggedAt: Date.now() };
    let dueNote = '';
    if (type === 'loan') {
        const pick = document.getElementById('loanPick_' + catId);
        if (pick && pick.value) entry.loanId = pick.value;
    }
    cat.expenses.unshift(entry);
    if (entry.loanId) {
        const loan = findLoanById(entry.loanId);
        if (loan) dueNote = loanDone(loan) ? ' · loan fully paid ✓' : ` · ${loan.name} paid for ${MONTHS_FULL[new Date().getMonth()]}`;
    }
    save(); noteEl.value = ''; amtEl.value = '';
    const landed = periodKeyFromISO(dateISO);
    renderCatBody(catId); renderBudgetCard(); renderLoanBadge(); renderGoalBadge();
    if (document.getElementById('loansModal').classList.contains('open')) renderLoans();
    if (landed !== activePeriod) { showToast(`Saved to ${periodLabel(landed)} — switch months to see it`); return }
    showToast(type === 'loan' ? 'Loan recorded' + dueNote : 'Expense logged ✓');
}

function deleteExpense(catId, expId) {
    const cat = state.categories.find(c => c.id === catId); if (!cat) return;
    cat.expenses = cat.expenses.filter(e => e.id !== expId);
    save(); renderCatBody(catId); renderBudgetCard();
    if (document.getElementById('loansModal').classList.contains('open')) renderLoans();
    showToast('Removed');
}

function openEdit(catId) {
    const cat = state.categories.find(c => c.id === catId); if (!cat) return;
    editingId = catId; document.getElementById('editName').value = cat.name;
    document.getElementById('editBudgetAmount').value = baseBudget(cat, activePeriod);
    document.getElementById('editCatTitle').textContent = 'Edit Category · ' + periodLabel(activePeriod);
    document.getElementById('editBudgetLabel').textContent = `Budget for ${periodLabel(activePeriod)} (${cur()})`;
    const hasOverride = !!(cat.periods && cat.periods[activePeriod] !== undefined);
    document.getElementById('editApplyAll').checked = !hasOverride;
    document.getElementById('editModal').classList.add('open');
}
function closeEditModal() { document.getElementById('editModal').classList.remove('open'); editingId = null }
function saveEdit() {
    const cat = state.categories.find(c => c.id === editingId); if (!cat) return;
    const name = document.getElementById('editName').value.trim();
    const budget = parseFloat(document.getElementById('editBudgetAmount').value);
    if (!name || isNaN(budget) || budget < 0) { showToast('Fill in all fields'); return }
    const applyAll = document.getElementById('editApplyAll').checked;
    cat.name = name;
    if (applyAll) {
        cat.budget = budget;
        if (cat.periods) delete cat.periods[activePeriod];
    } else {
        setBaseBudget(cat, activePeriod, budget);
    }
    save(); closeEditModal(); render();
    showToast(applyAll ? 'Category updated ✓' : `${periodLabel(activePeriod)} budget updated ✓`);
}

function deleteCategory(catId) {
    if (!confirm('Delete this category and all its expenses?')) return;
    state.categories = state.categories.filter(c => c.id !== catId); save(); render(); showToast('Category deleted');
}

function toggleCat(catId) {
    const body = document.getElementById('catBody_' + catId); const chev = document.getElementById('chev_' + catId);
    if (body) { body.classList.toggle('open'); if (chev) chev.classList.toggle('up') }
}

/* ════════════════════════════════════════════════════════════════
   SEARCH & DATE RANGES

   Search used to reach one month of one account's expenses. It now
   covers every kind of entry — spending, loan payments, money in and
   transfers — over any span of dates, in one account or both.
   ════════════════════════════════════════════════════════════════ */
let logsFilter = 'all';        /* all | spent | loan | in | transfer */
/* Opens on every entry rather than the current month: a tracker with a
   year of records behind it looked almost empty on the first open, which
   read as lost data rather than a filter. */
let logsRange = 'all';         /* month | 3m | 6m | year | all | custom */
let logsFrom = '', logsTo = '';
let logsScope = 'active';      /* active | both */
function catMark(name) { return (name || '?').trim().charAt(0).toUpperCase() || '?' }

/* the last day a period covers — the day before the next one starts */
function periodEndISO(key) {
    const next = periodStartISO(shiftPeriod(key, 1));
    const [y, m, d] = next.split('-').map(Number);
    const back = new Date(y, m - 1, d - 1);
    return `${back.getFullYear()}-${String(back.getMonth() + 1).padStart(2, '0')}-${String(back.getDate()).padStart(2, '0')}`;
}
function logsBounds() {
    if (logsRange === 'all') return { from: '', to: '' };
    if (logsRange === 'custom') return { from: logsFrom, to: logsTo };
    if (logsRange === 'year') {
        const y = activePeriod.slice(0, 4);
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    const back = logsRange === '3m' ? 2 : logsRange === '6m' ? 5 : 0;
    return { from: periodStartISO(shiftPeriod(activePeriod, -back)), to: periodEndISO(activePeriod) };
}
function logsRangeLabel() {
    const { from, to } = logsBounds();
    if (!from && !to) return 'every entry ever recorded';
    if (from && to) return `${isoToLabel(from)} – ${isoToLabel(to)}`;
    if (from) return `${isoToLabel(from)} onwards`;
    return `up to ${isoToLabel(to)}`;
}

function openLogs() {
    document.getElementById('logsModal').classList.add('open');
    document.getElementById('logsSearch').value = '';
    logsFilter = 'all'; logsRange = 'all'; logsScope = 'active';
    refreshLogs();
}
function closeLogs() { document.getElementById('logsModal').classList.remove('open') }
function logsIsOpen() { return document.getElementById('logsModal').classList.contains('open') }
/* search from anywhere: Ctrl/Cmd+K, or just "/" when not already typing */
function focusLogsSearch() {
    if (!logsIsOpen()) openLogs();
    const box = document.getElementById('logsSearch');
    if (box) { box.focus(); box.select() }
}
document.addEventListener('keydown', ev => {
    if (isLocked()) return;
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target && ev.target.tagName) || '') ||
        (ev.target && ev.target.isContentEditable);
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && ev.key.toLowerCase() === 'k') {
        ev.preventDefault(); focusLogsSearch(); return;
    }
    if (ev.key === '/' && !typing && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
        ev.preventDefault(); focusLogsSearch();
    }
});
/* re-draw without throwing away what the user has typed or chosen */
function refreshLogs() { renderLogsToolbar(); renderLogsTable() }

function setLogsFilter(f) {
    logsFilter = f;
    refreshLogs();
}
function setLogsRange(r) {
    logsRange = r;
    if (r === 'custom') {
        /* seed the pickers with the span that was on screen a moment ago */
        const b = logsBounds();
        const el = document.getElementById('logsFrom'), el2 = document.getElementById('logsTo');
        if (!logsFrom) logsFrom = b.from || periodStartISO(shiftPeriod(activePeriod, -2));
        if (!logsTo) logsTo = b.to || todayISO();
        if (el) el.value = logsFrom;
        if (el2) el2.value = logsTo;
    }
    refreshLogs();
    if (r === 'custom') { const el = document.getElementById('logsFrom'); if (el) el.focus() }
}
function onLogsCustomDate() {
    logsFrom = document.getElementById('logsFrom').value || '';
    logsTo = document.getElementById('logsTo').value || '';
    /* a backwards range is almost always a mis-click, so it is swapped */
    if (logsFrom && logsTo && logsFrom > logsTo) {
        const t = logsFrom; logsFrom = logsTo; logsTo = t;
        document.getElementById('logsFrom').value = logsFrom;
        document.getElementById('logsTo').value = logsTo;
    }
    logsRange = 'custom';
    refreshLogs();
}
function toggleLogsScope() {
    logsScope = logsScope === 'both' ? 'active' : 'both';
    refreshLogs();
}
function renderLogsToolbar() {
    document.querySelectorAll('.logs-range-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.range === logsRange));
    const ids = { all: 'filterAll', spent: 'filterSpent', loan: 'filterLoan', in: 'filterIn', transfer: 'filterTransfer' };
    Object.entries(ids).forEach(([f, id]) => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('active', logsFilter === f);
    });
    const custom = document.getElementById('logsCustom');
    if (custom) custom.classList.toggle('show', logsRange === 'custom');
    const scopeBtn = document.getElementById('logsScopeBtn');
    if (scopeBtn) {
        scopeBtn.setAttribute('aria-pressed', logsScope === 'both' ? 'true' : 'false');
    }
    setText('logsTitle', 'All Logs · ' +
        (logsScope === 'both' ? ACCOUNT_KEYS.map(accountLabel).join(' and ') : activeLabel()));
    const note = document.getElementById('logsRangeNote');
    if (note) {
        note.textContent = `Showing ${logsRangeLabel()} · ` +
            (logsScope === 'both' ? ACCOUNT_KEYS.map(accountLabel).join(' and ') : activeLabel()) +
            (logsRange === 'all' ? '' : '. Undated entries only appear under All time.');
    }
}

/* ── the entries themselves ── */
function logsEntryDate(e) { return e.dateRaw || labelToISO(e.date) || '' }
function logsCollect() {
    const { from, to } = logsBounds();
    const keys = logsScope === 'both' ? ACCOUNT_KEYS : [store.active];
    const out = [];
    keys.forEach(key => {
        const acct = store.accounts[key] || blankAccount();
        const label = accountLabel(key);
        (acct.categories || []).forEach(cat => (cat.expenses || []).forEach(e => out.push({
            acct: key, acctLabel: label, kind: expType(e) === 'loan' ? 'loan' : 'spent',
            catId: cat.id, catName: cat.name, id: e.id, note: e.note || '',
            amount: Number(e.amount) || 0, date: logsEntryDate(e), raw: e
        })));
        (acct.moneyIn || []).forEach(e => {
            const moved = isOutflowEntry(e);
            out.push({
                acct: key, acctLabel: label, kind: moved ? 'transfer' : 'in',
                setAside: isSetAside(e),
                catId: null,
                catName: isSetAside(e) ? 'Set aside' : moved ? (e.dir === 'out' ? 'Transfer out' : 'Transfer in') : 'Money in',
                id: e.id, note: e.note || '', amount: Number(e.amount) || 0,
                dir: e.dir || '', date: logsEntryDate(e), raw: e
            });
        });
    });
    return out.filter(x => {
        if (from && (!x.date || x.date < from)) return false;
        if (to && (!x.date || x.date > to)) return false;
        return true;
    });
}
function logsTerms() {
    return (document.getElementById('logsSearch').value || '')
        .toLowerCase().split(/\s+/).filter(Boolean);
}
/* every word typed must appear somewhere in the entry */
function logsMatches(x, terms) {
    if (!terms.length) return true;
    const hay = [x.note, x.catName, x.acctLabel, x.kind, x.date, fmt(x.amount), String(x.amount)]
        .join(' ').toLowerCase();
    return terms.every(t => hay.includes(t));
}
/* mark the matched words — built from the raw text and escaped piece by
   piece, so a search term can never land inside an HTML entity */
function logsHighlight(text, terms) {
    const s = String(text == null ? '' : text);
    if (!terms.length) return vizEsc(s);
    const rx = new RegExp('(' + terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    let out = '', last = 0, m;
    while ((m = rx.exec(s)) !== null) {
        if (m[0] === '') { rx.lastIndex++; continue }
        out += vizEsc(s.slice(last, m.index)) + '<mark class="logs-hit">' + vizEsc(m[0]) + '</mark>';
        last = m.index + m[0].length;
    }
    return out + vizEsc(s.slice(last));
}
/* open the right editor for a result, switching account first if needed */
function logsJumpTo(acctKey, kind, catId, id) {
    if (kind === 'transfer') { showToast('Transfers are edited from Add Money'); return }
    if (acctKey !== store.active) setAccount(acctKey);
    if (kind === 'in') editMoneyIn(id); else editExpense(catId, id);
}

function renderLogsTable() {
    const wrap = document.getElementById('logsTableWrap');
    const terms = logsTerms();
    let rows = logsCollect();
    if (logsFilter !== 'all') rows = rows.filter(x => x.kind === logsFilter);
    rows = rows.filter(x => logsMatches(x, terms));
    rows.sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        (Number(b.raw.loggedAt) || 0) - (Number(a.raw.loggedAt) || 0));

    setText('logsCount', `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'}`);
    if (!rows.length) {
        wrap.innerHTML = `<div class="logs-empty"><div class="orb">◆</div>
            <p>${terms.length ? 'Nothing matches that search in this range.' : 'No entries in this range yet.'}</p></div>`;
        return;
    }

    const moneyOut = rows.filter(x => x.kind === 'spent' || x.kind === 'loan' || (x.kind === 'transfer' && x.dir === 'out'))
        .reduce((s, x) => s + x.amount, 0);
    const moneyIn = rows.filter(x => x.kind === 'in' || (x.kind === 'transfer' && x.dir === 'in'))
        .reduce((s, x) => s + x.amount, 0);

    const showAcct = logsScope === 'both';
    const pill = { spent: ['pill-spent', 'Spent'], loan: ['pill-loan', 'Loan'], in: ['pill-in', 'Money in'], transfer: ['pill-transfer', 'Transfer'] };
    const amtClass = { spent: 'is-spent', loan: 'is-loan', in: 'is-in', transfer: 'is-transfer' };

    const body = rows.map(x => {
        const [cls, pillLabel] = pill[x.kind];
        const label = x.setAside ? 'Set aside' : pillLabel;
        const dateStr = fmtLogDate(x.raw), timeStr = fmtLogTime(x.raw);
        const when = timeStr
            ? `${dateStr}<br><span style="font-size:.65rem;color:var(--text-soft);">${timeStr}</span>`
            : dateStr;
        const clickable = x.kind !== 'transfer';
        return `<tr class="${x.kind === 'loan' ? 'loan-row ' : ''}${clickable ? 'logs-row-link' : ''}"
            ${clickable ? `onclick="logsJumpTo('${x.acct}','${x.kind}','${x.catId || ''}','${x.id}')"
                title="Open this entry"` : ''}>
            ${showAcct ? `<td><span class="log-acct-badge">${vizEsc(x.acctLabel)}</span></td>` : ''}
            <td><span class="log-cat-badge">${logsHighlight(x.catName, terms)}</span></td>
            <td class="log-note-cell" title="${vizEsc(x.note)}">${logsHighlight(x.note, terms)}</td>
            <td><span class="log-type-pill ${cls}">${label}</span></td>
            <td class="log-amount-cell ${amtClass[x.kind]}">${x.kind === 'in' || (x.kind === 'transfer' && x.dir === 'in') ? '+' : '−'}${fmt(x.amount)}</td>
            <td class="log-date-cell">${when}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `<table class="logs-table"><thead><tr>
        ${showAcct ? '<th>Account</th>' : ''}
        <th>Category</th><th>Note</th><th>Type</th><th>Amount</th><th>Date / Time</th>
    </tr></thead><tbody>${body}</tbody></table>
    <div class="logs-totals">
        <div class="logs-total-box"><span class="logs-total-label">Money out</span>
            <span class="logs-total-value out">${fmt(moneyOut)}</span></div>
        <div class="logs-total-box"><span class="logs-total-label">Money in</span>
            <span class="logs-total-value in">${fmt(moneyIn)}</span></div>
        <div class="logs-total-box"><span class="logs-total-label">Net</span>
            <span class="logs-total-value">${moneyIn - moneyOut < 0 ? '−' : ''}${fmt(Math.abs(moneyIn - moneyOut))}</span></div>
    </div>`;
}

function openReport() {
    buildReport();
    refreshExportMonths();
    document.getElementById('reportModal').classList.add('open');
}
function closeReport() { document.getElementById('reportModal').classList.remove('open') }
function toggleReportMonth(id) { const el = document.getElementById(id); if (el) el.classList.toggle('open') }

function buildReport() {
    const body = document.getElementById('reportBody');
    const allExp = [];
    state.categories.forEach(cat => cat.expenses.forEach(e => allExp.push({ ...e, type: expType(e), catName: cat.name })));

    // collect all months from both expenses and money-in
    const monthSet = new Set();
    allExp.forEach(e => { const key = e.dateRaw ? isoToMonthKey(e.dateRaw) : parseFallbackKey(e.date); if (key && key !== '0000-00') monthSet.add(key) });
    (state.moneyIn || []).forEach(e => { if (e.dateRaw) monthSet.add(isoToMonthKey(e.dateRaw)) });

    if (monthSet.size === 0 && allExp.length === 0) { body.innerHTML = '<div class="report-empty">No expenses or money added yet.</div>'; return }

    const sortedKeys = Array.from(monthSet).sort((a, b) => b.localeCompare(a));
    const grandTotal = allExp.reduce((s, e) => s + Number(e.amount), 0);
    const grandSpent = allExp.filter(e => e.type === 'spent').reduce((s, e) => s + Number(e.amount), 0);
    const grandLoan = allExp.filter(e => e.type === 'loan').reduce((s, e) => s + Number(e.amount), 0);
    const grandMoneyIn = (state.moneyIn || []).filter(e => !e.kind).reduce((s, e) => s + Number(e.amount), 0);

    let html = '';
    sortedKeys.forEach((key, idx) => {
        const [y, m] = key.split('-'); const monthLabel = `${MONTHS_FULL[parseInt(m) - 1]} ${y}`;

        // money-in for this month
        const monthAll = (state.moneyIn || []).filter(e => e.dateRaw && isoToMonthKey(e.dateRaw) === key);
        const monthMoneyIn = monthAll.filter(e => !e.kind);
        const monthTransfers = monthAll.filter(isOutflowEntry);
        const monthMoneyInTotal = monthMoneyIn.reduce((s, e) => s + Number(e.amount), 0);
        const monthTransferNet = monthTransfers.reduce((s, e) => s + (e.dir === 'out' ? -Number(e.amount) : Number(e.amount)), 0);

        // expenses for this month
        const exps = allExp.filter(e => {
            const k = e.dateRaw ? isoToMonthKey(e.dateRaw) : parseFallbackKey(e.date);
            return k === key;
        });
        const monthTotal = exps.reduce((s, e) => s + Number(e.amount), 0);
        const monthSpent = exps.filter(e => e.type === 'spent').reduce((s, e) => s + Number(e.amount), 0);
        const monthLoan = exps.filter(e => e.type === 'loan').reduce((s, e) => s + Number(e.amount), 0);

        // money-in section for this month
        let moneyInHtml = '';
        if (monthMoneyIn.length > 0) {
            const items = monthMoneyIn.map(e =>
                `<div class="report-money-in-item">
                    <span class="report-money-in-note">${e.note}</span>
                    <span class="report-money-in-date">${e.date}</span>
                    <span class="report-money-in-amt">${fmt(e.amount)}</span>
                </div>`
            ).join('');
            moneyInHtml = `<div class="report-money-in">
                <div class="report-money-in-header">
                    <span class="report-money-in-title">Money Added This Month</span>
                    <span class="report-money-in-total">${fmt(monthMoneyInTotal)}</span>
                </div>
                ${items}
            </div>`;
        }
        if (monthTransfers.length > 0) {
            const tItems = monthTransfers.map(e =>
                `<div class="report-money-in-item">
                    <span class="report-money-in-note">${e.note}</span>
                    <span class="report-money-in-date">${e.date}</span>
                    <span class="report-money-in-amt">${e.dir === 'out' ? '−' : '+'}${fmt(e.amount)}</span>
                </div>`
            ).join('');
            moneyInHtml += `<div class="report-money-in">
                <div class="report-money-in-header">
                    <span class="report-money-in-title">Moved Out This Month</span>
                    <span class="report-money-in-total">${monthTransferNet < 0 ? '−' : '+'}${fmt(Math.abs(monthTransferNet))}</span>
                </div>
                ${tItems}
            </div>`;
        }

        // category expense rows
        const catMap = {};
        exps.forEach(e => { if (!catMap[e.catName]) catMap[e.catName] = []; catMap[e.catName].push(e) });
        const catRows = Object.entries(catMap).map(([name, ces]) => {
            const catAmt = ces.reduce((s, e) => s + Number(e.amount), 0);
            const expItems = ces.map(e => {
                const isLoan = e.type === 'loan';
                return `<div class="report-exp-item${isLoan ? ' loan-exp-row' : ''}"><span class="rexp-type-tag ${isLoan ? 'rtag-loan' : 'rtag-spent'}">${isLoan ? 'Loan' : 'Spent'}</span><span class="rexp-note">${e.note}</span><span class="rexp-date">${e.date}</span><span class="rexp-amt${isLoan ? ' loan-rexp' : ''}">${fmt(e.amount)}</span></div>`;
            }).join('');
            return `<div class="report-cat-row"><span class="report-cat-name">${name}</span><span class="report-cat-amt">${fmt(catAmt)}</span></div><div class="report-exp-list">${expItems}</div>`;
        }).join('');

        const summaryBoxes = `
${monthMoneyInTotal > 0 ? `<div class="summary-box moneyin-box"><span class="summary-box-label">Money Added</span><span class="summary-box-value">${fmt(monthMoneyInTotal)}</span></div>` : ''}                    <div class="summary-box spent-box"><span class="summary-box-label">Total Spent</span><span class="summary-box-value">${fmt(monthSpent)}</span></div>
            ${monthLoan > 0 ? `<div class="summary-box loan-boDx"><span class="summary-box-label">Total Loan</span><span class="summary-box-value">${fmt(monthLoan)}</span></div>` : ''}
            <div class="summary-box total-box"><span class="summary-box-label">Grand Total</span><span class="summary-box-value">${fmt(monthTotal)}</span></div>
        `;

        html += `<div class="report-month">
            <div class="report-month-hdr" onclick="toggleReportMonth('rm${idx}')">
                <span class="report-month-name">${monthLabel}</span>
                <div class="report-month-totals">
${monthMoneyInTotal > 0 ? `<span class="report-total-chip" style="background:linear-gradient(135deg,var(--gold-50),var(--gold-100));color:var(--gold-600);border:1px solid var(--gold-200);">${fmt(monthMoneyInTotal)}</span>` : ''}                            <span class="report-total-chip chip-spent-total">${fmt(monthTotal)}</span>
                </div>
            </div>
            <div class="report-month-body${idx === 0 ? ' open' : ''}" id="rm${idx}">
                ${moneyInHtml}
                <div class="report-summary-row">${summaryBoxes}</div>
                ${catRows || '<div style="color:var(--text-muted);font-size:.8rem;font-style:italic;padding:8px 0;">No expenses this month.</div>'}
            </div>
        </div>`;
    });

    // grand totals footer
    html += `<div class="report-grand"><span class="report-grand-label">Grand Total All Expenses</span><span class="report-grand-amount">${fmt(grandTotal)}</span></div>`;
    if (grandMoneyIn > 0) {
        html += `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;">
            <div style="flex:1;min-width:120px;background:linear-gradient(135deg,var(--pos-soft),var(--pos-border));border:1px solid rgba(var(--pos-rgb), 0.25);border-radius:14px;padding:12px 16px;">
                <span style="font-size:.57rem;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--green-600);display:block;margin-bottom:4px;">All-time Money Added</span>
                <span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:var(--green-600);">${fmt(grandMoneyIn)}</span>
            </div>
            <div style="flex:1;min-width:120px;background:linear-gradient(135deg,var(--surface-2),var(--surface-3));border:1px solid rgba(var(--pos-rgb), 0.2);border-radius:14px;padding:12px 16px;">
                <span style="font-size:.57rem;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--gold-600);display:block;margin-bottom:4px;">All-time Spent</span>
                <span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:var(--green-600);">${fmt(grandSpent)}</span>
            </div>
            ${grandLoan > 0 ? `<div style="flex:1;min-width:120px;background:linear-gradient(135deg,var(--loan-bg),var(--loan-bg));border:1px solid rgba(var(--loan-rgb), 0.2);border-radius:14px;padding:12px 16px;"><span style="font-size:.57rem;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--loan-color);display:block;margin-bottom:4px;">All-time Loan</span><span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:var(--loan-color);">${fmt(grandLoan)}</span></div>` : ''}
        </div>`;
    } else if (grandLoan > 0) {
        html += `<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;"><div style="flex:1;min-width:120px;background:linear-gradient(135deg,var(--surface-2),var(--surface-3));border:1px solid rgba(var(--pos-rgb), 0.2);border-radius:14px;padding:12px 16px;"><span style="font-size:.57rem;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--gold-600);display:block;margin-bottom:4px;">All-time Spent</span><span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:var(--green-600);">${fmt(grandSpent)}</span></div><div style="flex:1;min-width:120px;background:linear-gradient(135deg,var(--loan-bg),var(--loan-bg));border:1px solid rgba(var(--loan-rgb), 0.2);border-radius:14px;padding:12px 16px;"><span style="font-size:.57rem;font-weight:600;letter-spacing:1.4px;text-transform:uppercase;color:var(--loan-color);display:block;margin-bottom:4px;">All-time Loan</span><span style="font-family:var(--font-display);font-size:1.05rem;font-weight:800;color:var(--loan-color);">${fmt(grandLoan)}</span></div></div>`;
    }

    body.innerHTML = html;
}

function renderBudgetCard() {
    const spent = totalSpentAll(); const bankRem = state.totalBudget - spent; const catRem = catTotalRem();
    const diff = bankRem - catRem; const pct = state.totalBudget > 0 ? Math.min((spent / state.totalBudget) * 100, 100) : 0;
    document.getElementById('budgetDisplay').textContent = valuesHidden ? mask() : fmt(state.totalBudget);
    document.getElementById('totalSpent').textContent = valuesHidden ? mask() : fmt(spent);
    const remEl = document.getElementById('totalRemaining'); remEl.textContent = valuesHidden ? mask() : fmt(bankRem);
    remEl.className = 'stat-value ' + (bankRem < 0 ? 'red' : 'green');
    document.getElementById('catTotalRemaining').textContent = valuesHidden ? mask() : fmt(catRem);
    setText('catRemHint', `left in ${periodLabel(activePeriod)}`);
    const diffPill = document.getElementById('diffPill'); const diffLbl = document.getElementById('diffLabel');
    const diffVal = document.getElementById('diffVal'); const diffHint = document.getElementById('diffHint');
    diffPill.className = 'stat-pill';
    if (diff > 0.005) { diffLbl.textContent = 'Excess'; diffVal.textContent = valuesHidden ? mask() : fmt(diff); diffVal.className = 'stat-value green'; diffHint.textContent = activeLabel() + ' covers ' + periodLabel(activePeriod); diffPill.classList.add('green-tint') }
    else if (diff < -0.005) { diffLbl.textContent = 'Short Budget'; diffVal.textContent = valuesHidden ? mask() : fmt(Math.abs(diff)); diffVal.className = 'stat-value red'; diffHint.textContent = periodLabel(activePeriod) + ' needs more than ' + activeLabel() + ' has'; diffPill.classList.add('red-tint') }
    else { diffLbl.textContent = 'Balanced'; diffVal.textContent = valuesHidden ? mask() : '₱0.00'; diffVal.className = 'stat-value yellow'; diffHint.textContent = 'Perfectly allocated ✓' }
    document.getElementById('totalProgress').style.width = pct + '%';
    document.getElementById('progressPct').textContent = pct.toFixed(0) + '% used';
}

function renderCatBody(catId) {
    const cat = state.categories.find(c => c.id === catId); const body = document.getElementById('catBody_' + catId); if (!cat || !body) return;
    const st = catStats(cat);
    const spent = st.spent, rem = st.rem, pct = st.pct, depleted = st.depleted;
    const cls = pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : '';
    const subEl = body.parentElement && body.parentElement.querySelector('.cat-sub');
    if (subEl) subEl.textContent = 'Budget: ' + fmt(st.budget);
    const remEl = document.getElementById('catRem_' + catId);
    if (remEl) { remEl.textContent = fmt(rem); remEl.className = 'cat-remaining' + (rem < 0 ? ' danger' : depleted ? ' zero' : rem < st.budget * .2 ? ' warning' : '') }
    const spEl = document.getElementById('catSpentSub_' + catId); if (spEl) spEl.textContent = fmt(spent) + ' spent';
    const progEl = document.getElementById('catProg_' + catId); if (progEl) { progEl.style.width = pct + '%'; progEl.className = 'cat-progress-fill ' + cls }
    const badgeEl = document.getElementById('catBadge_' + catId); if (badgeEl) badgeEl.style.display = rem < 0 ? 'inline' : 'none';
    const zeroBadge = document.getElementById('catZero_' + catId); if (zeroBadge) zeroBadge.style.display = (depleted && rem >= 0) ? 'inline' : 'none';
    const card = document.getElementById('catCard_' + catId); if (card) card.classList.toggle('depleted', depleted);
    ['expNote_', 'expAmt_', 'expDate_'].forEach(p => { const el = document.getElementById(p + catId); if (el) el.disabled = depleted });
    const logBtn = document.getElementById('catLogBtn_' + catId); if (logBtn) logBtn.disabled = depleted;
    const noticeEl = document.getElementById('catNotice_' + catId); if (noticeEl) noticeEl.style.display = depleted ? 'flex' : 'none';
    renderPeriodBar();
    const logEl = document.getElementById('catLog_' + catId); if (!logEl) return;
    const monthExps = expensesIn(cat, activePeriod);
    if (monthExps.length === 0) { logEl.innerHTML = `<div class="no-expenses">No expenses in ${periodLabel(activePeriod)}</div>`; return }
    logEl.innerHTML = monthExps.map(e => expenseRowHtml(catId, e)).join('');
}

/* one row in a category's expense list */
function expenseRowHtml(catId, e) {
    const isLoan = isLoanExp(e);
    const loan = isLoan && e.loanId ? findLoanById(e.loanId) : null;
    const extra = loan ? `<span class="loan-status">${loan.name}</span>` : '';
    const meta = e.date;
    return `<div class="expense-item${isLoan ? ' loan-item' : ''}"><div class="exp-main"><span class="exp-note" title="${e.note}">${e.note}</span><span class="exp-meta">${meta}</span></div>${extra}<span class="type-chip ${isLoan ? 'chip-loan' : 'chip-spent'}">${isLoan ? 'Loan' : 'Spent'}</span><span class="exp-amount${isLoan ? ' loan-amt' : ''}">${fmt(e.amount)}</span><button class="btn-edit-exp" onclick="editExpense('${catId}','${e.id}')" title="Edit" aria-label="Edit ${vizEsc(e.note)}, ${vizEsc(fmt(e.amount))}">✎</button><button class="btn-del-exp" onclick="deleteExpense('${catId}','${e.id}')" title="Remove" aria-label="Remove ${vizEsc(e.note)}, ${vizEsc(fmt(e.amount))}">×</button></div>`;
}

function render() {
    renderBackupAge();
    renderLoanBadge();
    renderGoalBadge();
    renderBudgetCard(); renderPeriodBar();
    const list = document.getElementById('categoriesList'); const empty = document.getElementById('emptyState');
    renderCatSortBar();
    if (state.categories.length === 0) { list.innerHTML = ''; empty.style.display = 'block'; return }
    empty.style.display = 'none'; const todayVal = periodDefaultDate();
    list.classList.toggle('reorderable', catSort() === 'custom');
    list.innerHTML = sortedCategories().map((cat, i) => {
        const st = catStats(cat);
        const spent = st.spent, rem = st.rem, pct = st.pct, depleted = st.depleted;
        const cls = pct >= 100 ? 'danger' : pct >= 80 ? 'warning' : '';
        const remCls = rem < 0 ? ' danger' : depleted ? ' zero' : rem < st.budget * .2 ? ' warning' : '';
        const dis = depleted ? 'disabled' : ''; const icon = catMark(cat.name);
        const monthExps = expensesIn(cat, activePeriod);
        const expLog = monthExps.length === 0 ? `<div class="no-expenses">No expenses in ${periodLabel(activePeriod)}</div>` : monthExps.map(e => expenseRowHtml(cat.id, e)).join('');
        return `<div class="cat-card${depleted ? ' depleted' : ''}" id="catCard_${cat.id}"
            data-cat="${cat.id}" style="animation-delay:${i * .07}s">
            <div class="cat-header" onclick="toggleCat('${cat.id}')">
                <button class="cat-grip" data-grip="${cat.id}" title="Drag to reorder"
                    aria-label="Reorder ${vizEsc(cat.name)}. Use the arrow keys to move it."
                    onclick="event.stopPropagation()" onkeydown="gripKey(event,'${cat.id}')">⠿</button>
                <div class="cat-icon"><span class="cat-emoji">${icon}</span></div>
                <div class="cat-info">
                    <div class="cat-name">${cat.name}<span class="badge-over" id="catBadge_${cat.id}" style="display:${rem < 0 ? 'inline' : 'none'}">Over!</span><span class="badge-zero" id="catZero_${cat.id}" style="display:${depleted && rem >= 0 ? 'inline' : 'none'}">Depleted</span></div>
                    <div class="cat-sub">Budget: ${fmt(st.budget)}</div>
                </div>
                <div class="cat-amounts">
                    <span class="cat-remaining${remCls}" id="catRem_${cat.id}">${fmt(rem)}</span>
                    <span class="cat-spent-sub" id="catSpentSub_${cat.id}">${fmt(spent)} spent</span>
                </div>
                <span class="chevron" id="chev_${cat.id}">▼</span>
            </div>
            <div class="cat-progress-wrap"><div class="cat-progress-track"><div class="cat-progress-fill ${cls}" id="catProg_${cat.id}" style="width:${pct}%"></div></div></div>
            <div class="cat-body" id="catBody_${cat.id}">
                <div class="depleted-notice" id="catNotice_${cat.id}" style="display:${depleted ? 'flex' : 'none'}">⚠️ This month's budget is fully used — add to it, or move to next month.</div>
                <div class="log-type-row">
                    <button class="log-type-btn active-spent" data-type-group="${cat.id}" data-type="spent" data-active-type="${cat.id}" onclick="setLogType('${cat.id}','spent',this)">Spent</button>
                    <button class="log-type-btn" data-type-group="${cat.id}" data-type="loan" onclick="setLogType('${cat.id}','loan',this)">Loan</button>
                </div>
                <div class="loan-extra-row" id="loanExtra_${cat.id}">
                    <select id="loanPick_${cat.id}" ${dis}>${loanOptionsHtml('')}</select>
                    <button type="button" class="loan-new-btn" onclick="openLoanForm()" ${dis}>＋ New loan</button>
                </div>
                <div class="exp-input-row">
                    <input type="text" id="expNote_${cat.id}" placeholder="Note (e.g. Electric bill)" maxlength="60" ${dis}>
                    <input type="number" id="expAmt_${cat.id}" placeholder="${cur()} Amount" min="0" step="0.01" style="max-width:115px;" ${dis}>
                    <input type="date" id="expDate_${cat.id}" value="${todayVal}" style="max-width:150px;" ${dis}>
                    <button class="btn-log" id="catLogBtn_${cat.id}" onclick="logExpense('${cat.id}')" ${dis}>+ Log</button>
                </div>
                <div class="expense-log" id="catLog_${cat.id}">${expLog}</div>
                <div class="cat-actions">
                    <button class="btn-add-budget-cat" onclick="openAddCatBudget('${cat.id}')">＋ Add</button>
                    <button class="btn-deduct-budget-cat" onclick="openDeductCatBudget('${cat.id}')">－ Deduct</button>
                    <button class="btn-edit-cat" onclick="openEdit('${cat.id}')">Edit</button>
                    <button class="btn-del-cat" onclick="deleteCategory('${cat.id}')">Delete</button>
                </div>
            </div>
        </div>`;
    }).join('');
    state.categories.forEach(cat => {
        const el = document.getElementById('expAmt_' + cat.id);
        if (el) el.addEventListener('keydown', ev => { if (ev.key === 'Enter') logExpense(cat.id) });
    });
}

/* Click-outside used to live here as a per-modal list: it covered only
   thirteen of the nineteen dialogues, and closed on any release over the
   backdrop — so selecting text inside a form and letting go past its edge
   threw the form away. It is handled for every dialogue now, with a guard
   on where the press began, next to the rest of the keyboard behaviour. */

let pendingImportData = null;
function openBackup() {
    pendingImportData = null;
    document.getElementById('importWarning').classList.remove('show');
    document.getElementById('btnConfirmImport').classList.remove('show');
    document.getElementById('btnMergeImport').classList.remove('show');
    document.getElementById('importFileInput').value = '';
    const line = key => {
        const acct = store.accounts[key]; const cats = acct.categories.length;
        const exps = acct.categories.reduce((s, c) => s + c.expenses.length, 0);
        return `${accountLabel(key)}: ${cats} categor${cats === 1 ? 'y' : 'ies'}, ${exps} expense${exps === 1 ? '' : 's'}`;
    };
    document.getElementById('exportMeta').textContent = `Current data — ${line('bank')} · ${line('cash')}`;
    document.getElementById('backupModal').classList.add('open');
}
function closeBackup() { document.getElementById('backupModal').classList.remove('open'); pendingImportData = null }
function exportData() {
    const backup = {
        _bank_backup: true, _version: 4, _exportedAt: new Date().toISOString(),
        active: store.active, settings: store.settings, accounts: store.accounts,
        /* the logo and backdrop live outside the records, so they are
           attached here on purpose rather than by accident */
        media: loadMedia()
    };
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = url; a.download = `bank-backup-${todayISO()}.json`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    store.lastBackupAt = new Date().toISOString(); save(); renderBackupAge();
    showToast('Backup downloaded ✓');
}
function handleDragOver(e) { e.preventDefault(); document.getElementById('importDropZone').classList.add('dragover') }
function handleDragLeave() { document.getElementById('importDropZone').classList.remove('dragover') }
function handleDrop(e) { e.preventDefault(); document.getElementById('importDropZone').classList.remove('dragover'); const file = e.dataTransfer.files[0]; if (file) processImportFile(file) }
function handleFileSelect(e) { const file = e.target.files[0]; if (file) processImportFile(file) }
function processImportFile(file) {
    if (!file.name.endsWith('.json')) { showToast('Please select a .json file'); return }
    const reader = new FileReader();
    reader.onload = function (e) {
        try {
            const data = JSON.parse(e.target.result);
            if (!data._bank_backup && !data._maribank_backup) { showToast('Not a valid Bank backup file'); return }
            pendingImportData = data;
            const sources = data.accounts ? [data.accounts.bank, data.accounts.cash] : [data];
            let cats = 0, exps = 0;
            sources.forEach(a => { const cs = (a && a.categories) || []; cats += cs.length; exps += cs.reduce((s, c) => s + ((c.expenses || []).length), 0) });
            const exportedAt = data._exportedAt ? new Date(data._exportedAt).toLocaleDateString('en-PH', { year: 'numeric', month: 'long', day: 'numeric' }) : 'unknown date';
            const scope = data.accounts ? 'both the Bank and Cash tabs' : `the ${activeLabel()} tab`;
            document.getElementById('importWarning').innerHTML = `⚠️ <strong>This will replace the data in ${scope}.</strong> The backup from <strong>${exportedAt}</strong> contains ${cats} categor${cats === 1 ? 'y' : 'ies'} and ${exps} expense${exps === 1 ? '' : 's'}. Export first if needed!`;
            document.getElementById('importWarning').classList.add('show');
            document.getElementById('btnConfirmImport').classList.add('show');
            document.getElementById('btnMergeImport').classList.add('show');
        } catch (err) { showToast('Could not read file — is it corrupted?') }
    }; reader.readAsText(file);
}
function confirmImport() {
    recoveryMode = false;   /* the user has chosen; saving is safe again */
    if (pendingImportData && pendingImportData.media) saveMedia(pendingImportData.media);
    if (!pendingImportData) return; const { _bank_backup, _maribank_backup, _version, _exportedAt, ...restored } = pendingImportData;
    if (restored.accounts) adoptStore(restored, !restored.settings);
    else { store.accounts[store.active] = normalizeAccount(restored); state = store.accounts[store.active] }
    save(); closeBackup(); applySettings(); applyAppearance(); syncAccountUI(); render();
    showToast('Data restored');
}
function mergeInto(target, incoming) {
    if (!incoming) return;
    target.totalBudget = (Number(target.totalBudget) || 0) + (Number(incoming.totalBudget) || 0);
    if (!target.moneyIn) target.moneyIn = [];
    const existingMoneyIds = new Set(target.moneyIn.map(e => e.id));
    (incoming.moneyIn || []).forEach(e => { if (!existingMoneyIds.has(e.id)) target.moneyIn.push(e) });
    if (!target.loans) target.loans = [];
    const existingLoanIds = new Set(target.loans.map(l => l.id));
    (incoming.loans || []).forEach(l => { if (!existingLoanIds.has(l.id)) target.loans.push(l) });
    if (!target.goals) target.goals = [];
    const existingGoalIds = new Set(target.goals.map(g => g.id));
    (incoming.goals || []).forEach(g => { if (!existingGoalIds.has(g.id)) target.goals.push(g) });
    (incoming.categories || []).forEach(inCat => {
        const existing = target.categories.find(c => c.name.toLowerCase() === inCat.name.toLowerCase());
        if (existing) { const existingIds = new Set(existing.expenses.map(e => e.id)); (inCat.expenses || []).forEach(e => { if (!existingIds.has(e.id)) existing.expenses.push(e) }) }
        else target.categories.push({ ...inCat, id: uid() });
    });
}
function mergeImport() {
    recoveryMode = false;
    /* a merge keeps the look already on this device — only the records join */
    if (!pendingImportData) return; const { _bank_backup, _maribank_backup, _version, _exportedAt, ...incoming } = pendingImportData;
    if (incoming.accounts) { mergeInto(store.accounts.bank, incoming.accounts.bank); mergeInto(store.accounts.cash, incoming.accounts.cash) }
    else mergeInto(state, incoming);
    save(); closeBackup(); render(); showToast('Data merged');
}

let editingExpCatId = null, editingExpId = null;
function editExpense(catId, expId) {
    const cat = state.categories.find(c => c.id === catId); if (!cat) return;
    const exp = cat.expenses.find(e => e.id === expId); if (!exp) return;
    editingExpCatId = catId; editingExpId = expId;
    document.getElementById('editExpNote').value = exp.note; document.getElementById('editExpAmount').value = exp.amount;
    document.getElementById('editExpDate').value = exp.dateRaw ? exp.dateRaw : exp.date ? (function () { const parts = exp.date.replace(',', '').split(' '); const m = String(MONTHS_SHORT.indexOf(parts[0]) + 1).padStart(2, '0'); const d = String(parts[1]).padStart(2, '0'); const y = parts[2]; return `${y}-${m}-${d}` })() : '';
    document.getElementById('editLoanPick').innerHTML = loanOptionsHtml(exp.loanId || '');
    document.getElementById('editGoalPick').innerHTML = goalOptionsHtml(exp.goalId || '');
    document.getElementById('editGoalFields').style.display = goalList().length ? 'block' : 'none';
    setEditExpType(exp.type || 'spent'); document.getElementById('editExpModal').classList.add('open');
}
function closeEditExpModal() { document.getElementById('editExpModal').classList.remove('open'); editingExpCatId = null; editingExpId = null }
function saveEditExp() {
    const cat = state.categories.find(c => c.id === editingExpCatId); if (!cat) return;
    const exp = cat.expenses.find(e => e.id === editingExpId); if (!exp) return;
    const note = document.getElementById('editExpNote').value.trim();
    const amount = parseFloat(document.getElementById('editExpAmount').value);
    const dateISO = document.getElementById('editExpDate').value;
    if (!note) { showToast('Add a note'); return } if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return } if (!dateISO) { showToast('Pick a date'); return }
    const loanBtn = document.getElementById('editExpTypeLoan'); const type = loanBtn.dataset.selected === '1' ? 'loan' : 'spent';
    exp.note = note; exp.amount = amount; exp.dateRaw = dateISO; exp.date = isoToLabel(dateISO); exp.type = type;
    if (type === 'loan') {
        const pick = document.getElementById('editLoanPick').value;
        if (pick) exp.loanId = pick; else delete exp.loanId;
    } else { delete exp.loanId }
    const goalPick = document.getElementById('editGoalPick').value;
    if (goalPick) exp.goalId = goalPick; else delete exp.goalId;
    if (document.getElementById('loansModal').classList.contains('open')) renderLoans();
    if (goalsIsOpen()) renderGoals();
    renderGoalBadge();
    const catId = editingExpCatId;
    save(); closeEditExpModal(); renderCatBody(catId); renderBudgetCard();
    if (logsIsOpen()) renderLogsTable();
    showToast('Expense updated ✓');
}
function toggleEditLoanFields(type) {
    const box = document.getElementById('editLoanFields');
    if (box) box.style.display = type === 'loan' ? 'block' : 'none';
}
function setEditExpType(type) {
    toggleEditLoanFields(type);
    const spentBtn = document.getElementById('editExpTypeSpent'); const loanBtn = document.getElementById('editExpTypeLoan');
    if (type === 'spent') { spentBtn.className = 'log-type-btn active-spent'; loanBtn.className = 'log-type-btn' }
    else { loanBtn.className = 'log-type-btn active-loan'; spentBtn.className = 'log-type-btn' }
    spentBtn.dataset.selected = type === 'spent' ? '1' : ''; loanBtn.dataset.selected = type === 'loan' ? '1' : '';
}
let addCatBudgetTargetId = null;
function openAddCatBudget(catId) {
    addCatBudgetTargetId = catId;
    document.getElementById('addCatBudgetAmount').value = '';
    document.getElementById('addCatBudgetModal').classList.add('open');
    setTimeout(() => document.getElementById('addCatBudgetAmount').focus(), 100);
}
function closeAddCatBudget() {
    document.getElementById('addCatBudgetModal').classList.remove('open');
    addCatBudgetTargetId = null;
}
function saveAddCatBudget() {
    const amount = parseFloat(document.getElementById('addCatBudgetAmount').value);
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    const cat = state.categories.find(c => c.id === addCatBudgetTargetId);
    if (!cat) return;
    setBaseBudget(cat, activePeriod, baseBudget(cat, activePeriod) + amount);
    save();
    closeAddCatBudget();
    render();
    showToast(`+${fmt(amount)} added to ${cat.name} for ${periodLabel(activePeriod)}`);
}
let deductCatBudgetTargetId = null;
function openDeductCatBudget(catId) {
    deductCatBudgetTargetId = catId;
    const cat = state.categories.find(c => c.id === catId);
    document.getElementById('deductCatBudgetAmount').value = '';
    document.getElementById('deductCatBudgetHint').textContent = cat ? `${periodLabel(activePeriod)} budget: ${fmt(baseBudget(cat, activePeriod))}` : '';
    document.getElementById('deductCatBudgetModal').classList.add('open');
    setTimeout(() => document.getElementById('deductCatBudgetAmount').focus(), 100);
}
function closeDeductCatBudget() {
    document.getElementById('deductCatBudgetModal').classList.remove('open');
    deductCatBudgetTargetId = null;
}
function saveDeductCatBudget() {
    const amount = parseFloat(document.getElementById('deductCatBudgetAmount').value);
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    const cat = state.categories.find(c => c.id === deductCatBudgetTargetId);
    if (!cat) return;
    const current = baseBudget(cat, activePeriod);
    if (amount > current) { showToast(`Can't deduct more than ${fmt(current)}`); return }
    setBaseBudget(cat, activePeriod, current - amount);
    save();
    closeDeductCatBudget();
    render();
    showToast(`−${fmt(amount)} deducted from ${cat.name} for ${periodLabel(activePeriod)}`);
}
function resetAll() {
    const L = activeLabel();
    if (!confirm(`Reset the ${L} tab? This deletes all ${L} categories, expenses, money-in history and its total budget. The other tab is not affected.`)) return;
    store.accounts[store.active] = blankAccount(); state = store.accounts[store.active];
    save(); render(); showToast(L + ' data cleared');
}
function toggleDataMenu() { document.getElementById('dataMenu').classList.toggle('open') }
function closeDataMenu() { document.getElementById('dataMenu').classList.remove('open') }
document.addEventListener('click', function (e) { const wrap = document.getElementById('dataDropdown'); if (wrap && !wrap.contains(e.target)) closeDataMenu() });

let valuesHidden = (lsGet('bank_hidden') || lsGet('maribank_hidden')) === '1';
function toggleVisibility() {
    valuesHidden = !valuesHidden;
    lsSet('bank_hidden', valuesHidden ? '1' : '0');
    const eyeBtn = document.getElementById('eyeBtn');
    /* the label says what the next press will do */
    eyeBtn.setAttribute('aria-label', valuesHidden ? 'Show amounts' : 'Hide amounts');
    eyeBtn.setAttribute('aria-pressed', valuesHidden ? 'true' : 'false');
    eyeBtn.innerHTML = valuesHidden
        ? `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
        : `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    renderBudgetCard(); renderPeriodBar();
}

if (valuesHidden) document.getElementById('eyeBtn').setAttribute('aria-label', 'Show amounts');
if (valuesHidden) document.getElementById('eyeBtn').setAttribute('aria-pressed', 'true');
if (valuesHidden) document.getElementById('eyeBtn').innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/* ── THEME ── */
const THEME_KEY = 'bank_theme';
const ICON_SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.2v2.4M12 19.4v2.4M4.2 12H1.8M22.2 12h-2.4M5.6 5.6 3.9 3.9M20.1 20.1l-1.7-1.7M18.4 5.6l1.7-1.7M3.9 20.1l1.7-1.7"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';
function currentTheme() { return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light' }
function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    const icon = document.getElementById('themeIcon');
    const label = document.getElementById('themeLabel');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (icon) icon.innerHTML = t === 'dark' ? ICON_MOON : ICON_SUN;
    if (label) label.textContent = t === 'dark' ? 'Dark' : 'Light';
    if (meta) meta.setAttribute('content', t === 'dark' ? '#211D1A' : '#322D29');
    refreshAppearanceForMode();
    if (document.getElementById('settingsModal').classList.contains('open')) {
        renderThemePicker(); renderAppearanceState();
    }
}
/* light and dark need different steps of the same chosen colour, so the
   palette is worked out again on every switch */
function refreshAppearanceForMode() {
    /* the palette module is defined below this point in the file, so on
       the very first pass its constants are not ready yet — the final
       line of the file applies it once everything exists */
    try { applyAppearance() } catch (e) { }
}
function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    lsSet(THEME_KEY, next);
    applyTheme(next);
}
applyTheme(currentTheme());

load(); applySettings(); syncAccountUI(); render();
renderLockSettings();
if (hasPin()) lockNow(); else document.documentElement.classList.remove('locked-boot');
maybeShowNotice();
/* if the browser refuses to store anything, say so straight away */
if (!storageWorks()) reportSaveFailure(null);

/* ────────────────────────────────────────────────────────────
   OFFLINE
   sw.js keeps a copy of the page, its styles, its script and
   the fonts, so after one visit the tracker opens with no
   connection at all. The data itself never needed the network
   — it has always lived in this browser's storage.
   ──────────────────────────────────────────────────────────── */
function showOfflineState() {
    const pill = document.getElementById('offlinePill');
    if (pill) pill.classList.toggle('show', navigator.onLine === false);
}
window.addEventListener('online', showOfflineState);
window.addEventListener('offline', showOfflineState);
showOfflineState();

/* Bump together with CACHE in sw.js. Shown in Settings so the version a
   device is actually running can be read off the screen — without it,
   "it still behaves like the old one" is impossible to check. */
const APP_VERSION = 'v24';
let swError = null;
(function registerOfflineWorker() {
    /* Service workers only exist over http(s); opening the file
       directly from disk still works, just without precaching. */
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;

    let waitingWorker = null;
    const bar = document.getElementById('updateBar');
    const showUpdateBar = sw => { waitingWorker = sw; if (bar) bar.classList.add('show') };
    const hideUpdateBar = () => { if (bar) bar.classList.remove('show') };

    const btnNow = document.getElementById('updateNow');
    const btnLater = document.getElementById('updateLater');
    if (btnNow) btnNow.onclick = () => {
        hideUpdateBar();
        if (waitingWorker) waitingWorker.postMessage('skip-waiting'); else location.reload();
    };
    if (btnLater) btnLater.onclick = hideUpdateBar;

    /* On the very first visit the worker takes control without a
       controller having existed, and that must not bounce the page. */
    const hadController = !!navigator.serviceWorker.controller;
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        location.reload();
    });

    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').then(reg => {
            if (reg.waiting && navigator.serviceWorker.controller) showUpdateBar(reg.waiting);
            reg.addEventListener('updatefound', () => {
                const sw = reg.installing;
                if (!sw) return;
                sw.addEventListener('statechange', () => {
                    /* an existing controller means this is an update, not the first install */
                    if (sw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBar(sw);
                });
            });
        }).catch(err => {
            /* Swallowing this made an offline failure impossible to explain
               on a phone, where there is no console to look at. It is kept
               and shown in Settings instead. */
            swError = (err && err.message) ? err.message : String(err);
        });
    });
})();

/* ════════════════════════════════════════════════════════════════
   CHARTS

   Three views of the same records: where the money went this month
   (donut), how the months compare (trend), and how each category is
   doing against its allowance (budget vs actual).

   Drawn as plain SVG so nothing has to be fetched — the charts work
   with no connection, like the rest of the tracker. Colours come
   from --series-1..6 in styles.css and are handed out in a fixed
   order, so a category keeps its colour as you move between months.
   Every chart has a table twin ("Show numbers"), so no value is
   reachable only by hovering.
   ════════════════════════════════════════════════════════════════ */

let chartsPeriod = null;      /* the month the charts are focused on */
let chartsAsTable = false;    /* "Show numbers" — the table view */
const VIZ_SLOTS = 6;          /* colour slots before the tail folds into "Other" */
const VIZ_TREND_MONTHS = 12;

/* category names are typed by the user, so they are escaped before
   they are ever put into markup */
function vizEsc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* the eye toggle hides amounts here too — the shapes stay, the numbers do not */
function vizNum(v) { return valuesHidden ? mask() : fmt(v) }
function vizCompact(n) {
    if (valuesHidden) return '•••';
    const v = Math.abs(Number(n) || 0);
    const s = v >= 1e9 ? (v / 1e9).toFixed(v >= 1e10 ? 0 : 1) + 'B'
        : v >= 1e6 ? (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M'
            : v >= 1e3 ? (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k'
                : String(Math.round(v));
    return (Number(n) < 0 ? '−' : '') + cur() + s.replace(/\.0(?=[kMB]?$)/, '');
}
/* axis ticks land on round numbers — 0 / 2,000 / 4,000, never 0 / 1,873 */
function vizTicks(max, count) {
    if (!(max > 0)) return [0];
    const raw = max / (count || 4);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / mag;
    const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
    const out = [];
    for (let v = 0; v <= max + step * 1e-6; v += step) out.push(v);
    if (out[out.length - 1] < max) out.push(out[out.length - 1] + step);
    return out;
}
function vizColor(i) { return i < VIZ_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)' }

/* ── the focus month ── */
function chartsFocus() { return chartsPeriod || activePeriod }
function vizPeriodsWithActivity() {
    const set = new Set();
    state.categories.forEach(c => (c.expenses || []).forEach(e => set.add(periodOf(e))));
    (state.moneyIn || []).forEach(e => { if (e.dateRaw) set.add(periodKeyFromISO(e.dateRaw)) });
    set.delete('0000-00');
    return Array.from(set).sort();
}
function vizStepMonth(delta) {
    chartsPeriod = shiftPeriod(chartsFocus(), delta);
    renderCharts();
}
function toggleChartsTable() {
    chartsAsTable = !chartsAsTable;
    renderCharts();
}

/* ── tooltip ──
   Marks carry their readout in data- attributes and the handler sets
   it with textContent, so a category name can never be read as markup
   or as code. */
function vizTipEl() { return document.getElementById('vizTip') }
function vizShowTip(ev) {
    const el = vizTipEl(), mark = ev.currentTarget;
    if (!el || !mark) return;
    const d = mark.dataset;
    el.innerHTML = '<span class="viz-tip-val"></span>' +
        '<span class="viz-tip-name"><span class="viz-tip-key"></span><span class="viz-tip-who"></span></span>' +
        '<span class="viz-tip-extra"></span>';
    el.querySelector('.viz-tip-val').textContent = d.vizVal || '';
    el.querySelector('.viz-tip-who').textContent = d.vizName || '';
    el.querySelector('.viz-tip-key').style.background = d.vizColor || 'var(--on-ink-dim)';
    const extra = el.querySelector('.viz-tip-extra');
    extra.textContent = d.vizExtra || '';
    extra.hidden = !d.vizExtra;
    const r = mark.getBoundingClientRect();
    el.style.left = Math.min(window.innerWidth - 20, Math.max(20, r.left + r.width / 2)) + 'px';
    el.style.top = Math.max(56, r.top) + 'px';
    el.classList.add('show');
}
function vizHideTip() { const el = vizTipEl(); if (el) el.classList.remove('show') }

/* highlight one slice from either the arc or its legend row */
function vizFocusSlice(i, on) {
    const donut = document.getElementById('vizDonut');
    if (donut) {
        donut.classList.toggle('dimmed', on);
        donut.querySelectorAll('.viz-arc').forEach(a =>
            a.classList.toggle('hot', on && a.dataset.i === String(i)));
    }
    const row = document.querySelector('.viz-legend-row[data-i="' + i + '"]');
    if (row) row.classList.toggle('hot', on);
}
function vizSliceEnter(ev) { vizFocusSlice(ev.currentTarget.dataset.i, true); vizShowTip(ev) }
function vizSliceLeave(ev) { vizFocusSlice(ev.currentTarget.dataset.i, false); vizHideTip() }

/* ════════ 1. SPEND BY CATEGORY — donut ════════ */
function vizCategorySlices(period) {
    const rows = state.categories
        .map(c => ({ name: c.name, value: catSpent(c, period) }))
        .filter(r => r.value > 0.005)
        .sort((a, b) => b.value - a.value);
    if (rows.length <= VIZ_SLOTS + 1) return rows;
    /* never invent a 7th hue: the tail becomes one labelled "Other" */
    const head = rows.slice(0, VIZ_SLOTS);
    const tail = rows.slice(VIZ_SLOTS);
    head.push({ name: 'Other', value: tail.reduce((s, r) => s + r.value, 0), tail: tail.length });
    return head;
}
function vizArcPath(cx, cy, rOut, rIn, a0, a1) {
    const big = (a1 - a0) > Math.PI ? 1 : 0;
    const pt = (r, a) => (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2);
    return `M${pt(rOut, a0)}A${rOut} ${rOut} 0 ${big} 1 ${pt(rOut, a1)}` +
        `L${pt(rIn, a1)}A${rIn} ${rIn} 0 ${big} 0 ${pt(rIn, a0)}Z`;
}
function vizDonutHtml(period) {
    const slices = vizCategorySlices(period);
    const total = slices.reduce((s, r) => s + r.value, 0);
    if (!slices.length) {
        return `<div class="viz-empty">Nothing spent in ${vizEsc(periodLabel(period))} yet.</div>`;
    }

    const cx = 100, cy = 100, rOut = 82, rIn = 55, rMid = (rOut + rIn) / 2;
    /* a 2px gap of plain surface separates the slices — no strokes are
       drawn around them, and there is no gap when there is only one */
    const gap = slices.length > 1 ? 2 / rMid : 0;
    const hooks = 'onmouseenter="vizSliceEnter(event)" onfocus="vizSliceEnter(event)" ' +
        'onmouseleave="vizSliceLeave(event)" onblur="vizSliceLeave(event)"';

    let a = -Math.PI / 2;
    const arcs = slices.map((r, i) => {
        const span = (r.value / total) * Math.PI * 2;
        const start = a; a += span;
        let a0 = start + gap / 2, a1 = start + span - gap / 2;
        /* a slice thinner than the gap still gets a visible sliver */
        if (a1 <= a0) { a0 = start; a1 = start + Math.max(span, 0.008) }
        const pct = (r.value / total * 100);
        const attrs = `class="viz-arc" data-i="${i}" tabindex="0" role="img"
            data-viz-val="${vizEsc(vizNum(r.value))}" data-viz-name="${vizEsc(r.name)}"
            data-viz-color="${vizColor(i)}" data-viz-extra="${pct.toFixed(1)}% of the month"
            aria-label="${vizEsc(r.name)}: ${vizEsc(vizNum(r.value))}, ${pct.toFixed(1)} percent of the month"
            ${hooks}`;
        /* one category means a full ring — an arc from a point back to
           itself draws nothing, so that case is a stroked circle */
        return slices.length === 1
            ? `<circle ${attrs} cx="${cx}" cy="${cy}" r="${rMid}" fill="none"
                 stroke="${vizColor(i)}" stroke-width="${rOut - rIn}"></circle>`
            : `<path ${attrs} fill="${vizColor(i)}" d="${vizArcPath(cx, cy, rOut, rIn, a0, a1)}"></path>`;
    }).join('');

    const legend = slices.map((r, i) => `
        <div class="viz-legend-row" data-i="${i}"
            onmouseenter="vizFocusSlice(${i},true)" onmouseleave="vizFocusSlice(${i},false)">
            <span class="viz-swatch" style="background:${vizColor(i)}"></span>
            <span class="viz-legend-name" title="${vizEsc(r.name)}">${vizEsc(r.name)}${r.tail ? ` <span style="color:var(--text-soft)">(${r.tail})</span>` : ''}</span>
            <span class="viz-legend-val">${vizEsc(vizNum(r.value))}</span>
            <span class="viz-legend-pct">${(r.value / total * 100).toFixed(0)}%</span>
        </div>`).join('');

    return `<div class="viz-donut-wrap">
        <svg class="viz-donut" id="vizDonut" viewBox="0 0 200 200" role="group"
            aria-label="Spending by category for ${vizEsc(periodLabel(period))}">
            ${arcs}
            <text class="viz-center-label" x="100" y="93" text-anchor="middle">Total spent</text>
            <text class="viz-center-value" x="100" y="117" text-anchor="middle">${vizEsc(vizNum(total))}</text>
        </svg>
        <div class="viz-legend">${legend}</div>
    </div>`;
}

/* ════════ 2. MONTH-OVER-MONTH — trend ════════ */
function vizTrendPeriods() {
    const active = vizPeriodsWithActivity();
    const focus = chartsFocus();
    /* the run is contiguous: a month with nothing logged is a real
       zero, not a gap to be closed up */
    let end = focus;
    if (active.length && active[active.length - 1] > end) end = active[active.length - 1];
    const first = active.length ? active[0] : focus;
    const stop = first < focus ? first : focus;
    const out = [];
    let k = end;
    for (let i = 0; i < VIZ_TREND_MONTHS; i++) {
        out.unshift(k);
        if (k <= stop) break;
        k = shiftPeriod(k, -1);
    }
    return out;
}
function vizTrendHtml() {
    const keys = vizTrendPeriods();
    const pts = keys.map(k => ({ key: k, value: monthSpentAll(k) }));
    if (pts.length < 2) {
        return '<div class="viz-empty">Once there are two months of records, the trend appears here.</div>';
    }

    const W = 640, H = 230, padL = 54, padR = 20, padT = 18, padB = 34;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const ticks = vizTicks(Math.max(...pts.map(p => p.value)), 4);
    const top = ticks[ticks.length - 1] || 1;
    const x = i => padL + (i / (pts.length - 1)) * plotW;
    const y = v => padT + plotH - (v / top) * plotH;

    const grid = ticks.map(t =>
        `<line class="viz-grid-line" x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}"></line>
         <text class="viz-tick" x="${padL - 9}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end">${vizEsc(vizCompact(t))}</text>`
    ).join('');

    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join('');
    const area = `${line}L${x(pts.length - 1).toFixed(1)} ${(padT + plotH).toFixed(1)}L${x(0).toFixed(1)} ${(padT + plotH).toFixed(1)}Z`;

    const focus = chartsFocus();
    const maxIdx = pts.reduce((b, p, i) => p.value > pts[b].value ? i : b, 0);
    const hooks = 'onmouseenter="vizShowTip(event)" onfocus="vizShowTip(event)" ' +
        'onmouseleave="vizHideTip()" onblur="vizHideTip()"';

    const marks = pts.map((p, i) => {
        const hot = p.key === focus;
        const color = hot ? 'var(--series-2)' : 'var(--series-1)';
        /* the marker carries a 2px surface ring so it stays legible on the line */
        return `<circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${hot ? 5.5 : 4}"
                fill="${color}" stroke="var(--surface)" stroke-width="2"></circle>
            <rect class="viz-hit" x="${(x(i) - 18).toFixed(1)}" y="${padT}" width="36" height="${plotH}"
                tabindex="0" role="img"
                data-viz-val="${vizEsc(vizNum(p.value))}" data-viz-name="${vizEsc(periodLabel(p.key))}"
                data-viz-color="${color}"
                aria-label="${vizEsc(periodLabel(p.key))}: ${vizEsc(vizNum(p.value))} spent"
                ${hooks}></rect>`;
    }).join('');

    /* label selectively — the latest month and the highest, never every point */
    const tag = i => `<text class="viz-mark-label strong" x="${x(i).toFixed(1)}"
        y="${(y(pts[i].value) - 11).toFixed(1)}"
        text-anchor="${i === 0 ? 'start' : i === pts.length - 1 ? 'end' : 'middle'}">${vizEsc(vizCompact(pts[i].value))}</text>`;
    const labels = tag(pts.length - 1) + (maxIdx !== pts.length - 1 ? tag(maxIdx) : '');

    /* on a crowded axis every other month is enough */
    const every = pts.length > 8 ? 2 : 1;
    const xLabels = pts.map((p, i) => {
        if (i % every !== 0 && i !== pts.length - 1) return '';
        const mm = p.key.slice(5);
        const showYear = mm === '01' || i === 0;
        return `<text class="viz-tick" x="${x(i).toFixed(1)}" y="${H - 12}" text-anchor="middle">${MONTHS_SHORT[parseInt(mm) - 1]}${showYear ? ' ’' + p.key.slice(2, 4) : ''}</text>`;
    }).join('');

    return `<div class="viz-scroll"><svg class="viz-svg" viewBox="0 0 ${W} ${H}" style="min-width:460px"
            role="group" aria-label="Total spent per month">
        ${grid}
        <path d="${area}" fill="var(--viz-area)"></path>
        <path d="${line}" fill="none" stroke="var(--series-1)" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"></path>
        ${marks}${labels}
        <line class="viz-axis-line" x1="${padL}" y1="${(padT + plotH).toFixed(1)}" x2="${W - padR}" y2="${(padT + plotH).toFixed(1)}"></line>
        ${xLabels}
    </svg></div>`;
}

/* ════════ 3. BUDGET VS ACTUAL — bars ════════ */
function vizBudgetRows(period) {
    return state.categories.map(c => ({
        name: c.name,
        budget: catBudget(c, period),
        spent: catSpent(c, period)
    }));
}
/* a horizontal bar with a 4px rounded data-end and a square baseline */
function vizBarPath(x, y, w, h, r) {
    if (w <= 0.5) return '';
    const rr = Math.min(r, w, h / 2);
    return `M${x} ${y}H${(x + w - rr).toFixed(1)}a${rr} ${rr} 0 0 1 ${rr} ${rr}` +
        `V${(y + h - rr).toFixed(1)}a${rr} ${rr} 0 0 1 ${-rr} ${rr}H${x}Z`;
}
function vizBudgetHtml(period) {
    const all = vizBudgetRows(period);
    const rows = all.filter(r => r.budget > 0.005)
        .sort((a, b) => (b.spent / b.budget) - (a.spent / a.budget));
    const noBudget = all.filter(r => r.budget <= 0.005 && r.spent > 0.005).length;

    if (!rows.length) {
        return `<div class="viz-empty">No category has an allowance for ${vizEsc(periodLabel(period))} yet.
            Set one and this chart fills in.</div>`;
    }

    /* Each row is a meter against its own allowance, so bar length reads
       as "how far in" and matches the percentage beside it. Every track
       ends at the same x — that shared line is the allowance, and a bar
       crossing it is over budget. The pesos live in the tooltip and the
       table, where they can be compared properly. */
    const W = 640, padR = 16, rowH = 38, barH = 14;
    const H = rows.length * rowH + 18;
    const trackX = 128, zone = W - trackX - padR - 52;
    const worst = Math.max(1, ...rows.map(r => r.spent / r.budget));
    /* one runaway category must not squash every other bar into nothing,
       so the scale stops at 200% and anything past it is marked as cut off */
    const scale = Math.min(worst, 2);
    const unit = zone / scale;              /* pixels per 100% */
    const limitX = trackX + unit;           /* the allowance line */
    const hooks = 'onmouseenter="vizShowTip(event)" onfocus="vizShowTip(event)" ' +
        'onmouseleave="vizHideTip()" onblur="vizHideTip()"';

    const bars = rows.map((r, i) => {
        const y = i * rowH + 8;
        const ratio = r.spent / r.budget;
        const over = r.spent > r.budget + 0.005;
        const clipped = ratio > scale + 0.005;
        const sw = Math.min(ratio, scale) * unit;
        const color = over ? 'var(--viz-over)' : 'var(--series-1)';
        const pct = Math.round(ratio * 100);
        const extra = `${vizNum(r.spent)} of ${vizNum(r.budget)}` +
            (over ? ` — over by ${vizNum(r.spent - r.budget)}` : ` — ${vizNum(r.budget - r.spent)} left`);
        /* a long name is trimmed here rather than clipped by the mark, and
           stays whole in the tooltip, the row title and the table */
        const short = r.name.length > 17 ? r.name.slice(0, 16) + '…' : r.name;
        return `<g>
            <text class="viz-mark-label strong" x="0" y="${y + barH / 2 + 4}">${vizEsc(short)}</text>
            <rect x="${trackX}" y="${y}" width="${unit.toFixed(1)}" height="${barH}" rx="4"
                fill="var(--viz-track)"></rect>
            <path d="${vizBarPath(trackX, y, sw, barH, 4)}" fill="${color}"></path>
            ${clipped ? `<path d="M${(trackX + sw - 7).toFixed(1)} ${y + 3}l5 ${barH / 2 - 3}l-5 ${barH / 2 - 3}"
                fill="none" stroke="var(--surface)" stroke-width="2" stroke-linecap="round"></path>` : ''}
            <text class="viz-mark-label strong" x="${W - padR}" y="${y + barH / 2 + 4}" text-anchor="end"
                ${over ? 'style="fill:var(--viz-over)"' : ''}>${pct}%</text>
            <rect class="viz-hit" x="0" y="${y - 7}" width="${W}" height="${barH + 14}"
                tabindex="0" role="img"
                data-viz-val="${vizEsc(vizNum(r.spent))}" data-viz-name="${vizEsc(r.name)}"
                data-viz-color="${color}" data-viz-extra="${vizEsc(extra)}"
                aria-label="${vizEsc(r.name)}: ${vizEsc(extra)}, ${pct} percent${over ? ', over budget' : ''}"
                ${hooks}></rect>
        </g>`;
    }).join('');

    /* the allowance line sits on top of the bars, kept legible by a 2px
       gap of plain surface rather than a stroke around every mark */
    const limit = `<line x1="${limitX.toFixed(1)}" y1="2" x2="${limitX.toFixed(1)}" y2="${H - 12}"
            stroke="var(--surface)" stroke-width="4"></line>
        <line class="viz-axis-line" x1="${limitX.toFixed(1)}" y1="2" x2="${limitX.toFixed(1)}" y2="${H - 12}"></line>
        <text class="viz-tick" x="${limitX.toFixed(1)}" y="${H - 2}" text-anchor="middle">allowance</text>`;

    return `<div class="viz-scroll"><svg class="viz-svg" viewBox="0 0 ${W} ${H}" style="min-width:460px"
            role="group" aria-label="Budget against actual spending per category">
        ${bars}${limit}
    </svg></div>
    <div class="viz-key">
        <span class="viz-key-item"><span class="viz-key-swatch" style="background:var(--viz-track)"></span>Allowance</span>
        <span class="viz-key-item"><span class="viz-key-swatch" style="background:var(--series-1)"></span>Spent</span>
        <span class="viz-key-item"><span class="viz-key-swatch" style="background:var(--viz-over)"></span>Over budget</span>
    </div>
    ${noBudget ? `<p class="viz-note">${noBudget} categor${noBudget === 1 ? 'y has' : 'ies have'} spending but no allowance set for this month, so ${noBudget === 1 ? 'it is' : 'they are'} not charted here.</p>` : ''}`;
}

/* ════════ the table twin ════════ */
function vizTablesHtml(period) {
    const slices = vizCategorySlices(period);
    const total = slices.reduce((s, r) => s + r.value, 0);
    const catRows = slices.length
        ? slices.map((r, i) => `<tr>
            <td><span class="viz-table-swatch" style="background:${vizColor(i)}"></span>${vizEsc(r.name)}</td>
            <td class="num">${vizEsc(vizNum(r.value))}</td>
            <td class="num">${(r.value / total * 100).toFixed(1)}%</td>
        </tr>`).join('')
        : '<tr><td colspan="3" style="color:var(--text-muted);font-style:italic">Nothing spent this month.</td></tr>';

    const trend = vizTrendPeriods().map(k =>
        `<tr><td>${vizEsc(periodLabel(k))}</td><td class="num">${vizEsc(vizNum(monthSpentAll(k)))}</td></tr>`).join('');

    const flow = vizTrendPeriods().map(k => {
        const f = vizCashFlow(k);
        return `<tr><td>${vizEsc(periodLabel(k))}</td>
            <td class="num">${vizEsc(vizNum(f.in))}</td>
            <td class="num">${vizEsc(vizNum(f.out))}</td>
            <td class="num${f.net < 0 ? ' over' : ''}">${f.net < 0 ? '−' : '+'}${vizEsc(vizNum(Math.abs(f.net)))}</td></tr>`;
    }).join('');

    const budget = vizBudgetRows(period)
        .filter(r => r.budget > 0.005 || r.spent > 0.005)
        .sort((a, b) => b.spent - a.spent)
        .map(r => {
            const over = r.spent > r.budget + 0.005;
            const left = r.budget - r.spent;
            return `<tr>
                <td>${vizEsc(r.name)}</td>
                <td class="num">${r.budget > 0.005 ? vizEsc(vizNum(r.budget)) : '—'}</td>
                <td class="num">${vizEsc(vizNum(r.spent))}</td>
                <td class="num${over ? ' over' : ''}">${r.budget > 0.005 ? (over ? '−' : '') + vizEsc(vizNum(Math.abs(left))) : '—'}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="4" style="color:var(--text-muted);font-style:italic">No categories yet.</td></tr>';

    return `
    <div class="viz-card">
        <div class="viz-head"><span class="viz-title">Spending by category</span>
            <span class="viz-sub">${vizEsc(periodLabel(period))}</span></div>
        <table class="viz-table"><thead><tr><th>Category</th><th class="num">Spent</th><th class="num">Share</th></tr></thead>
            <tbody>${catRows}</tbody></table>
    </div>
    <div class="viz-card">
        <div class="viz-head"><span class="viz-title">Month by month</span>
            <span class="viz-sub">Total spent each month</span></div>
        <table class="viz-table"><thead><tr><th>Month</th><th class="num">Spent</th></tr></thead>
            <tbody>${trend}</tbody></table>
    </div>
    <div class="viz-card">
        <div class="viz-head"><span class="viz-title">Money in against money out</span>
            <span class="viz-sub">Transfers to your other account count as money out</span></div>
        <table class="viz-table"><thead><tr><th>Month</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr></thead>
            <tbody>${flow}</tbody></table>
    </div>
    <div class="viz-card">
        <div class="viz-head"><span class="viz-title">Budget against actual</span>
            <span class="viz-sub">${vizEsc(periodLabel(period))} — a minus under Left means over budget</span></div>
        <table class="viz-table"><thead><tr><th>Category</th><th class="num">Budget</th><th class="num">Spent</th><th class="num">Left</th></tr></thead>
            <tbody>${budget}</tbody></table>
    </div>`;
}

/* ════════ assembly ════════ */
function renderCharts() {
    const body = document.getElementById('chartsBody'); if (!body) return;
    const period = chartsFocus();

    setText('chartsTitle', 'Charts · ' + activeLabel());
    setText('chartsMonthLabel', periodLabel(period));
    const toggle = document.getElementById('chartsViewToggle');
    if (toggle) {
        toggle.textContent = chartsAsTable ? 'Show charts' : 'Show numbers';
        toggle.classList.toggle('on', chartsAsTable);
        toggle.setAttribute('aria-pressed', chartsAsTable ? 'true' : 'false');
    }
    vizHideTip();

    const anything = state.categories.some(c => (c.expenses || []).length) || (state.moneyIn || []).length;
    if (!anything) {
        body.innerHTML = `<div class="viz-empty">No records yet. Add a category and log something,
            and the charts fill themselves in.</div>`;
        return;
    }

    if (chartsAsTable) { body.innerHTML = vizTablesHtml(period); return }

    body.innerHTML = `
    <div class="viz-card">
        <div class="viz-head">
            <span class="viz-title">Where the money went</span>
            <span class="viz-sub">${vizEsc(periodLabel(period))}</span>
        </div>
        ${vizDonutHtml(period)}
    </div>
    <div class="viz-card">
        <div class="viz-head">
            <span class="viz-title">Month by month</span>
            <span class="viz-sub">Total spent each month. The month you are looking at is marked in orange.</span>
        </div>
        ${vizTrendHtml()}
    </div>
    <div class="viz-card">
        <div class="viz-head">
            <span class="viz-title">Money in against money out</span>
            <span class="viz-sub">What came in and what went out each month, and whether the month
                finished ahead or behind.</span>
        </div>
        ${vizFlowHtml()}
    </div>
    <div class="viz-card">
        <div class="viz-head">
            <span class="viz-title">Budget against actual</span>
            <span class="viz-sub">How far into each allowance you are for ${vizEsc(periodLabel(period))}.</span>
        </div>
        ${vizBudgetHtml(period)}
    </div>`;
}
function openCharts() {
    chartsPeriod = activePeriod;
    renderCharts();
    document.getElementById('chartsModal').classList.add('open');
}
function closeCharts() {
    vizHideTip();
    document.getElementById('chartsModal').classList.remove('open');
}

/* ════════════════════════════════════════════════════════════════
   EXPORT — CSV, print and PDF

   The JSON backup is for bringing the tracker back; these are for
   sending the records to someone else. Spreadsheets go out as CSV,
   and anything else goes through the browser's own print dialogue,
   which is also where "Save as PDF" lives — no PDF library to fetch,
   so this works with no connection like everything else here.

   Amounts are always written in full, even when the eye toggle is
   hiding them on screen: a masked export would be useless to the
   person you are sending it to.
   ════════════════════════════════════════════════════════════════ */

function exportAccountKeys() {
    const el = document.getElementById('exportAccount');
    return el && el.value === 'both' ? ACCOUNT_KEYS.slice() : [store.active];
}
/* '' means every month */
function exportMonthKey() {
    const el = document.getElementById('exportMonth');
    return el ? el.value : '';
}
function exportRangeLabel() {
    const m = exportMonthKey();
    return m ? periodLabel(m) : 'All months';
}
function exportMonthsAvailable() {
    const set = new Set();
    exportAccountKeys().forEach(key => {
        const a = store.accounts[key] || blankAccount();
        (a.categories || []).forEach(c => (c.expenses || []).forEach(e => set.add(periodOf(e))));
        (a.moneyIn || []).forEach(e => { if (e.dateRaw) set.add(periodKeyFromISO(e.dateRaw)) });
    });
    set.delete('0000-00');
    return Array.from(set).filter(Boolean).sort((a, b) => b.localeCompare(a));
}
function refreshExportMonths() {
    const sel = document.getElementById('exportMonth'); if (!sel) return;
    const keep = sel.value;
    const months = exportMonthsAvailable();
    sel.innerHTML = '<option value="">All months</option>' +
        months.map(k => `<option value="${k}">${vizEsc(periodLabel(k))}</option>`).join('');
    sel.value = months.indexOf(keep) >= 0 ? keep : '';
    renderExportHint();
}
function renderExportHint() {
    const el = document.getElementById('exportHint'); if (!el) return;
    const rows = exportRows();
    const accounts = exportAccountKeys().map(accountLabel).join(' and ');
    el.textContent = rows.length
        ? `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} · ${exportRangeLabel()} · ${accounts}. ` +
        'CSV opens in Excel, Numbers or Google Sheets. Print gives you a PDF through "Save as PDF".'
        : `Nothing to export for ${exportRangeLabel()} in ${accounts}.`;
}

/* ── every line item, flattened ── */
function exportRows() {
    const only = exportMonthKey();
    const rows = [];
    exportAccountKeys().forEach(key => {
        const acct = store.accounts[key] || blankAccount();
        const label = accountLabel(key);
        (acct.categories || []).forEach(cat => (cat.expenses || []).forEach(e => {
            const p = periodOf(e);
            if (only && p !== only) return;
            rows.push({
                date: e.dateRaw || labelToISO(e.date) || '',
                period: p, account: label, kind: 'Expense', category: cat.name,
                type: expType(e) === 'loan' ? 'Loan payment' : 'Spent',
                note: e.note || '', amount: Number(e.amount) || 0, sign: -1
            });
        }));
        (acct.moneyIn || []).forEach(e => {
            const p = e.dateRaw ? periodKeyFromISO(e.dateRaw) : parseFallbackKey(e.date);
            if (only && p !== only) return;
            const moved = isOutflowEntry(e);
            rows.push({
                date: e.dateRaw || '', period: p, account: label,
                kind: isSetAside(e) ? 'Set aside' : moved ? 'Transfer' : 'Money in', category: '',
                type: isSetAside(e) ? 'Into a savings goal' : moved ? (e.dir === 'out' ? 'Sent out' : 'Received') : '',
                note: e.note || '', amount: Number(e.amount) || 0,
                sign: moved && e.dir === 'out' ? -1 : 1
            });
        });
    });
    return rows.sort((a, b) =>
        String(a.date).localeCompare(String(b.date)) || a.account.localeCompare(b.account));
}

/* ── one row per month (per account) ── */
function exportSummary() {
    const only = exportMonthKey();
    const out = [];
    exportAccountKeys().forEach(key => {
        const acct = store.accounts[key] || blankAccount();
        const label = accountLabel(key);
        const keys = new Set();
        (acct.categories || []).forEach(c => (c.expenses || []).forEach(e => keys.add(periodOf(e))));
        (acct.moneyIn || []).forEach(e => { if (e.dateRaw) keys.add(periodKeyFromISO(e.dateRaw)) });
        keys.delete('0000-00');
        Array.from(keys).filter(k => k && (!only || k === only)).sort().forEach(p => {
            let spent = 0, loan = 0, moneyIn = 0, tIn = 0, tOut = 0, aside = 0, budget = 0;
            (acct.categories || []).forEach(c => {
                budget += catBudget(c, p);
                (c.expenses || []).forEach(e => {
                    if (periodOf(e) !== p) return;
                    if (expType(e) === 'loan') loan += Number(e.amount) || 0;
                    else spent += Number(e.amount) || 0;
                });
            });
            (acct.moneyIn || []).forEach(e => {
                const k = e.dateRaw ? periodKeyFromISO(e.dateRaw) : parseFallbackKey(e.date);
                if (k !== p) return;
                const amt = Number(e.amount) || 0;
                if (isSetAside(e)) aside += amt;
                else if (isTransfer(e)) { if (e.dir === 'out') tOut += amt; else tIn += amt }
                else moneyIn += amt;
            });
            out.push({
                period: p, account: label, moneyIn, transfersIn: tIn, transfersOut: tOut,
                setAside: aside, spent, loan, totalOut: spent + loan, budget,
                net: moneyIn + tIn - tOut - aside - spent - loan
            });
        });
    });
    return out.sort((a, b) => a.period.localeCompare(b.period) || a.account.localeCompare(b.account));
}

/* ── one row per category per month ── */
function exportBudgets() {
    const only = exportMonthKey();
    const out = [];
    exportAccountKeys().forEach(key => {
        const acct = store.accounts[key] || blankAccount();
        const label = accountLabel(key);
        const keys = new Set();
        (acct.categories || []).forEach(c => (c.expenses || []).forEach(e => keys.add(periodOf(e))));
        keys.delete('0000-00');
        if (!keys.size) keys.add(activePeriod);
        Array.from(keys).filter(k => k && (!only || k === only)).sort().forEach(p => {
            (acct.categories || []).forEach(c => {
                const budget = catBudget(c, p), spent = catSpent(c, p);
                if (budget <= 0.005 && spent <= 0.005) return;
                out.push({
                    period: p, account: label, name: c.name, budget, spent,
                    left: budget - spent, pct: budget > 0 ? Math.round(spent / budget * 100) : null
                });
            });
        });
    });
    return out;
}

/* ── CSV plumbing ── */
function csvCell(v) {
    const s = v == null ? '' : String(v);
    if (/^-?\d+(\.\d+)?$/.test(s)) return s;      /* a plain number, left bare for the spreadsheet */
    /* a cell starting =, +, - or @ is read as a formula by Excel and
       Sheets, so it is pushed back into being text */
    const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
    return '"' + safe.replace(/"/g, '""') + '"';
}
function csvNum(n) { return (Math.round((Number(n) || 0) * 100) / 100).toFixed(2) }
function toCsv(header, rows) {
    /* the BOM is what makes Excel read ₱ and accented notes correctly */
    return '\ufeff' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
function downloadFile(name, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 2000);
}
function exportSlug() {
    return (settings().appName || 'tracker').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tracker';
}
function exportFileName(what, ext) {
    return `${exportSlug()}-${what}-${exportMonthKey() || 'all-months'}.${ext}`;
}

function exportTransactionsCsv() {
    const rows = exportRows();
    if (!rows.length) { showToast('Nothing to export for that range'); return }
    const body = rows.map(r => [
        r.date, r.period, r.account, r.kind, r.category, r.type, r.note,
        csvNum(r.amount), csvNum(r.amount * r.sign), cur()
    ]);
    downloadFile(exportFileName('transactions', 'csv'), toCsv(
        ['Date', 'Month', 'Account', 'Kind', 'Category', 'Type', 'Note', 'Amount', 'Signed amount', 'Currency'],
        body), 'text/csv');
    showToast(`${rows.length} entries exported ✓`);
}
function exportSummaryCsv() {
    const rows = exportSummary();
    if (!rows.length) { showToast('Nothing to export for that range'); return }
    const body = rows.map(r => [
        r.period, periodLabel(r.period), r.account, csvNum(r.moneyIn), csvNum(r.transfersIn),
        csvNum(r.transfersOut), csvNum(r.setAside), csvNum(r.spent), csvNum(r.loan), csvNum(r.totalOut),
        csvNum(r.budget), csvNum(r.net), cur()
    ]);
    downloadFile(exportFileName('monthly-summary', 'csv'), toCsv(
        ['Month', 'Period', 'Account', 'Money in', 'Transfers in', 'Transfers out', 'Set aside',
            'Spent', 'Loan payments', 'Total out', 'Budgeted', 'Net', 'Currency'],
        body), 'text/csv');
    showToast('Monthly summary exported ✓');
}
function exportBudgetsCsv() {
    const rows = exportBudgets();
    if (!rows.length) { showToast('No categories to export for that range'); return }
    const body = rows.map(r => [
        r.period, periodLabel(r.period), r.account, r.name, csvNum(r.budget), csvNum(r.spent),
        csvNum(r.left), r.pct == null ? '' : r.pct, r.left < -0.005 ? 'Over budget' : '', cur()
    ]);
    downloadFile(exportFileName('category-budgets', 'csv'), toCsv(
        ['Month', 'Period', 'Account', 'Category', 'Budget', 'Spent', 'Left', 'Used %', 'Status', 'Currency'],
        body), 'text/csv');
    showToast('Category budgets exported ✓');
}

/* ── the printed sheet ── */
function prMoney(n) { return fmt(n) }
function prTable(head, bodyRows, footRow, empty) {
    if (!bodyRows.length) return `<p class="pr-empty">${vizEsc(empty)}</p>`;
    return `<table class="pr-table">
        <thead><tr>${head.map(h => `<th${h.num ? ' class="num"' : ''}>${vizEsc(h.label)}</th>`).join('')}</tr></thead>
        <tbody>${bodyRows.join('')}</tbody>
        ${footRow ? `<tfoot><tr>${footRow}</tr></tfoot>` : ''}
    </table>`;
}
/* Savings goals are a standing position rather than a month's activity,
   so the printed section always shows them in full, whatever range the
   rest of the sheet covers. */
function prGoalsSection() {
    const rows = [];
    exportAccountKeys().forEach(key => {
        const acct = store.accounts[key] || blankAccount();
        (acct.goals || []).forEach(g => {
            /* goalSaved() reads the active account, so the sum is done here
               against whichever account this goal actually belongs to */
            let saved = 0;
            (acct.categories || []).forEach(c => (c.expenses || []).forEach(e => {
                if (e.goalId === g.id) saved += Number(e.amount) || 0;
            }));
            const target = Number(g.target) || 0;
            rows.push({ account: accountLabel(key), name: g.name, target, saved, targetDate: g.targetDate || '' });
        });
    });
    if (!rows.length) return '';
    const body = rows.map(r => {
        const left = Math.max(0, r.target - r.saved);
        const pct = r.target > 0 ? Math.round(r.saved / r.target * 100) : 0;
        return `<tr>
            <td>${vizEsc(r.account)}</td>
            <td>${vizEsc(r.name)}</td>
            <td>${r.targetDate ? vizEsc(isoToLabel(r.targetDate)) : '—'}</td>
            <td class="num">${prMoney(r.target)}</td>
            <td class="num">${prMoney(r.saved)}</td>
            <td class="num">${prMoney(left)}</td>
            <td class="num">${pct}%</td>
        </tr>`;
    });
    return `<div class="pr-section">
        <h2>Savings goals</h2>
        ${prTable(
        [{ label: 'Account' }, { label: 'Goal' }, { label: 'Target date' }, { label: 'Target', num: 1 },
        { label: 'Saved', num: 1 }, { label: 'To go', num: 1 }, { label: 'Done', num: 1 }],
        body, '', 'No savings goals.')}
    </div>`;
}
function buildPrintSheet() {
    const sheet = document.getElementById('printSheet'); if (!sheet) return;
    sheet.innerHTML = printSheetHtml();
}
function printSheetHtml() {
    const st = settings();
    const accounts = exportAccountKeys().map(accountLabel).join(' & ');
    const sums = exportSummary(), buds = exportBudgets(), rows = exportRows();

    const sumBody = sums.map(s => `<tr>
        <td>${vizEsc(periodLabel(s.period))}</td>
        <td>${vizEsc(s.account)}</td>
        <td class="num">${prMoney(s.moneyIn)}</td>
        <td class="num">${prMoney(s.spent)}</td>
        <td class="num">${prMoney(s.loan)}</td>
        <td class="num">${prMoney(s.totalOut)}</td>
        <td class="num">${s.net < 0 ? '−' : ''}${prMoney(Math.abs(s.net))}</td>
    </tr>`);
    const tot = sums.reduce((a, s) => ({
        moneyIn: a.moneyIn + s.moneyIn, spent: a.spent + s.spent, loan: a.loan + s.loan,
        totalOut: a.totalOut + s.totalOut, net: a.net + s.net
    }), { moneyIn: 0, spent: 0, loan: 0, totalOut: 0, net: 0 });
    const sumFoot = `<td colspan="2">Total</td>
        <td class="num">${prMoney(tot.moneyIn)}</td><td class="num">${prMoney(tot.spent)}</td>
        <td class="num">${prMoney(tot.loan)}</td><td class="num">${prMoney(tot.totalOut)}</td>
        <td class="num">${tot.net < 0 ? '−' : ''}${prMoney(Math.abs(tot.net))}</td>`;

    const budBody = buds.map(b => `<tr>
        <td>${vizEsc(periodLabel(b.period))}</td>
        <td>${vizEsc(b.account)}</td>
        <td>${vizEsc(b.name)}</td>
        <td class="num">${b.budget > 0.005 ? prMoney(b.budget) : '—'}</td>
        <td class="num">${prMoney(b.spent)}</td>
        <td class="num${b.left < -0.005 ? ' pr-over' : ''}">${b.budget > 0.005 ? (b.left < 0 ? '−' : '') + prMoney(Math.abs(b.left)) : '—'}</td>
        <td class="num${b.left < -0.005 ? ' pr-over' : ''}">${b.pct == null ? '—' : b.pct + '%'}</td>
    </tr>`);

    const txBody = rows.map(r => `<tr>
        <td>${vizEsc(r.date ? isoToLabel(r.date) : '—')}</td>
        <td>${vizEsc(r.account)}</td>
        <td>${vizEsc(r.category || '—')}</td>
        <td>${vizEsc(r.note)}</td>
        <td>${vizEsc(r.type || r.kind)}</td>
        <td class="num">${r.sign < 0 ? '−' : '+'}${prMoney(r.amount)}</td>
    </tr>`);

    return `
    <div class="pr-head">
        <div class="pr-title">${vizEsc(st.appName || 'Budget')} — Report</div>
        <div class="pr-sub">${vizEsc(st.appTagline || '')}</div>
        <div class="pr-meta">${vizEsc(exportRangeLabel())} · ${vizEsc(accounts)} ·
            prepared ${vizEsc(isoToLabel(todayISO()))}</div>
    </div>

    <div class="pr-section">
        <h2>Month by month</h2>
        ${prTable(
        [{ label: 'Month' }, { label: 'Account' }, { label: 'Money in', num: 1 }, { label: 'Spent', num: 1 },
        { label: 'Loan payments', num: 1 }, { label: 'Total out', num: 1 }, { label: 'Net', num: 1 }],
        sumBody, sumBody.length ? sumFoot : '', 'No months with activity in this range.')}
    </div>

    <div class="pr-section">
        <h2>Budget against actual</h2>
        ${prTable(
        [{ label: 'Month' }, { label: 'Account' }, { label: 'Category' }, { label: 'Budget', num: 1 },
        { label: 'Spent', num: 1 }, { label: 'Left', num: 1 }, { label: 'Used', num: 1 }],
        budBody, '', 'No categories with a budget or any spending in this range.')}
    </div>

    ${prGoalsSection()}

    <div class="pr-section">
        <h2>Every entry</h2>
        ${prTable(
        [{ label: 'Date' }, { label: 'Account' }, { label: 'Category' }, { label: 'Note' },
        { label: 'Type' }, { label: 'Amount', num: 1 }],
        txBody, '', 'No entries in this range.')}
    </div>

    <p class="pr-foot">${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} ·
        amounts in ${vizEsc(cur())} · a minus sign means money leaving the account.
        Generated by ${vizEsc(st.appName || 'this tracker')} on ${vizEsc(isoToLabel(todayISO()))}.</p>`;
}
/* The stylesheet for the printed document. It is kept here, complete and
   self-contained, because the sheet is printed from its own blank document
   rather than from the app page — the app's fixed-position backdrop, its
   body vignette and its stacking contexts all survive a "hide everything
   else" rule and paint straight over the page, which is what produced a
   blank sheet. Printing a clean document sidesteps the lot. */
const PRINT_CSS = `
@page { margin: 14mm 12mm; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: #fff; color: #000;
    font-family: Georgia, 'Times New Roman', serif; font-size: 10.5pt; line-height: 1.45; }
.pr-head { border-bottom: 2px solid #000; padding-bottom: 10px; margin-bottom: 18px; }
.pr-title { font-size: 20pt; font-weight: 700; letter-spacing: .5px; margin-bottom: 2px; }
.pr-sub { font-size: 10pt; color: #333; }
.pr-meta { margin-top: 8px; font-size: 9pt; color: #444; }
.pr-section { margin: 0 0 22px; }
.pr-section h2 { font-size: 12pt; font-weight: 700; letter-spacing: .4px; text-transform: uppercase;
    border-bottom: 1px solid #999; padding-bottom: 4px; margin-bottom: 8px; break-after: avoid; }
.pr-table { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
.pr-table thead { display: table-header-group; }
.pr-table th { text-align: left; font-size: 8pt; font-weight: 700; letter-spacing: .6px;
    text-transform: uppercase; border-bottom: 1px solid #000; padding: 5px 6px; }
.pr-table td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; }
.pr-table tr { break-inside: avoid; }
.pr-table .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
.pr-table tfoot td { border-top: 1.5px solid #000; border-bottom: none; font-weight: 700; padding-top: 6px; }
.pr-over { font-weight: 700; }
.pr-empty { font-style: italic; color: #555; padding: 6px 0; }
.pr-foot { margin-top: 20px; padding-top: 8px; border-top: 1px solid #999; font-size: 8.5pt; color: #444; }
`;
function printReport() {
    if (!exportRows().length) { showToast('Nothing to print for that range'); return }
    buildPrintSheet();   /* keeps the plain Ctrl+P route working too */

    const title = `${settings().appName} report — ${exportRangeLabel()}`;
    const old = document.getElementById('printFrame');
    if (old) old.remove();

    const frame = document.createElement('iframe');
    frame.id = 'printFrame';
    frame.setAttribute('aria-hidden', 'true');
    /* off-screen rather than display:none — a hidden frame has no layout,
       and a frame with no layout prints nothing */
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:210mm;height:297mm;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(frame);

    /* Opened from a file:// path some browsers refuse the frame's document.
       That is what the on-page print stylesheet is still there for. */
    let doc = null;
    try {
        doc = frame.contentDocument;
        doc.open();
        doc.write('<!doctype html><html><head><meta charset="utf-8"><title>' +
            vizEsc(title) + '</title><style>' + PRINT_CSS + '</style></head><body>' +
            printSheetHtml() + '</body></html>');
        doc.close();
    } catch (e) { doc = null }

    if (!doc) {
        frame.remove();
        const previous = document.title;
        document.title = title;
        setTimeout(() => { window.print(); document.title = previous }, 60);
        return;
    }

    const go = () => {
        try {
            frame.contentWindow.focus();
            frame.contentWindow.print();
        } catch (e) {
            /* if the frame is refused for any reason, fall back to the page itself */
            window.print();
        }
        /* leave it up long enough for the dialogue to take its snapshot */
        setTimeout(() => frame.remove(), 60000);
    };
    if (doc.readyState === 'complete') setTimeout(go, 60);
    else frame.onload = () => setTimeout(go, 60);
}

/* ════════════════════════════════════════════════════════════════
   SAVINGS GOALS / SINKING FUNDS

   A goal is a name, a target amount and — optionally — a date to
   have it by. Money is put aside by logging a real expense against
   a category and tagging it with goalId, the mirror of how a loan
   payment works. That matters: money set aside genuinely leaves the
   spendable balance, so it cannot be counted twice, and the entry
   shows up in the logs, charts, reports and exports like any other.
   ════════════════════════════════════════════════════════════════ */

let goalsFilter = 'open';       /* open | done | all */
let editingGoalId = null;
let contribGoalId = null;

function goalList() { return state.goals || (state.goals = []) }
function findGoalById(id) { return goalList().find(g => g.id === id) || null }
function isGoalExp(e) { return !!(e && e.goalId) }
/* every entry tagged with this goal, newest first */
function goalContributions(goalId) {
    const out = [];
    state.categories.forEach(cat => (cat.expenses || []).forEach(e => {
        if (e.goalId === goalId) out.push({ e, cat });
    }));
    return out.sort((a, b) => String(b.e.dateRaw || '').localeCompare(String(a.e.dateRaw || '')));
}
function goalSetAsides(goalId) {
    return (state.moneyIn || [])
        .filter(e => isSetAside(e) && e.goalId === goalId)
        .sort((a, b) => String(b.dateRaw || '').localeCompare(String(a.dateRaw || '')));
}
function goalSaved(goal) {
    return goalContributions(goal.id).reduce((s, x) => s + (Number(x.e.amount) || 0), 0) +
        goalSetAsides(goal.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
}
/* both kinds of deposit in one list, newest first, each saying where it came from */
function goalDeposits(goalId) {
    const out = goalContributions(goalId).map(x => ({
        date: x.e.date, dateRaw: x.e.dateRaw, source: x.cat.name, amount: Number(x.e.amount) || 0
    }));
    goalSetAsides(goalId).forEach(e => out.push({
        date: e.date, dateRaw: e.dateRaw, source: 'Excess money', amount: Number(e.amount) || 0
    }));
    return out.sort((a, b) => String(b.dateRaw || '').localeCompare(String(a.dateRaw || '')));
}
function goalTarget(goal) { return Number(goal.target) || 0 }
function goalLeft(goal) { return Math.max(0, goalTarget(goal) - goalSaved(goal)) }
function goalDone(goal) { return goalTarget(goal) > 0 && goalLeft(goal) <= 0.005 }

function daysUntil(iso) {
    if (!iso) return null;
    const [y, m, d] = iso.split('-').map(Number);
    const end = new Date(y, m - 1, d);
    const now = new Date(); now.setHours(0, 0, 0, 0);
    return Math.round((end - now) / 86400000);
}
/* what should have been saved by today if the goal were on a straight
   line from the day it was created to the day it is due */
function goalExpected(goal) {
    if (!goal.targetDate || goalTarget(goal) <= 0) return null;
    const start = goal.createdAt ? new Date(goal.createdAt) : new Date();
    const [y, m, d] = goal.targetDate.split('-').map(Number);
    const end = new Date(y, m - 1, d, 23, 59, 59);
    const span = end - start;
    if (span <= 0) return null;
    const elapsed = Math.min(Math.max(Date.now() - start, 0), span);
    return goalTarget(goal) * (elapsed / span);
}
/* how much a month is still needed to land on the date */
function goalMonthly(goal) {
    const left = goalLeft(goal);
    if (!goal.targetDate || left <= 0) return null;
    const days = daysUntil(goal.targetDate);
    if (days === null || days <= 0) return null;
    return left / Math.max(1, Math.ceil(days / 30.44));
}
function goalStatus(goal) {
    if (goalDone(goal)) return { label: 'Reached', cls: ' good', card: ' done', fill: '' };
    if (!goal.targetDate) return { label: 'Saving', cls: '', card: '', fill: '' };
    const days = daysUntil(goal.targetDate);
    if (days < 0) return { label: 'Date has passed', cls: ' late', card: ' late', fill: ' late' };
    const expected = goalExpected(goal);
    /* a 10% grace so a goal is not called "behind" the day after payday */
    if (expected !== null && goalSaved(goal) < expected * 0.9) {
        return { label: 'Behind', cls: ' warn', card: ' behind', fill: ' behind' };
    }
    if (days === 0) return { label: 'Due today', cls: ' warn', card: ' behind', fill: '' };
    return { label: 'On track', cls: ' good', card: '', fill: '' };
}
function goalNeedsAttention(goal) {
    const s = goalStatus(goal);
    return s.card === ' behind' || s.card === ' late';
}
function goalsSavedTotal() { return goalList().reduce((s, g) => s + goalSaved(g), 0) }
function goalsTargetTotal() { return goalList().reduce((s, g) => s + goalTarget(g), 0) }
function goalsLeftTotal() { return goalList().reduce((s, g) => s + goalLeft(g), 0) }

function renderGoalBadge() {
    const btn = document.getElementById('btnGoals'); if (!btn) return;
    const old = document.getElementById('goalsBadge'); if (old) old.remove();
    const n = goalList().filter(goalNeedsAttention).length;
    btn.classList.toggle('behind', n > 0);
    if (n > 0) {
        btn.title = n === 1 ? 'A savings goal has slipped behind' : `${n} savings goals have slipped behind`;
        btn.insertAdjacentHTML('beforeend', `<span class="goal-badge" id="goalsBadge">${n}</span>`);
    } else btn.removeAttribute('title');
}

/* ── the modal ── */
function goalsIsOpen() { return document.getElementById('goalsModal').classList.contains('open') }
function openGoals() {
    setText('goalsTitle', 'Savings Goals · ' + activeLabel());
    renderGoals();
    document.getElementById('goalsModal').classList.add('open');
}
function closeGoals() { document.getElementById('goalsModal').classList.remove('open') }
function setGoalsFilter(f) {
    goalsFilter = f;
    ['goalFilterOpen', 'goalFilterDone', 'goalFilterAll'].forEach(id =>
        document.getElementById(id).classList.remove('active'));
    document.getElementById(f === 'open' ? 'goalFilterOpen' : f === 'done' ? 'goalFilterDone' : 'goalFilterAll')
        .classList.add('active');
    renderGoals();
}
function renderGoals() {
    setText('goalsSaved', valuesHidden ? mask() : fmt(goalsSavedTotal()));
    setText('goalsLeft', valuesHidden ? mask() : fmt(goalsLeftTotal()));
    setText('goalsTarget', valuesHidden ? mask() : fmt(goalsTargetTotal()));

    const list = document.getElementById('goalsList');
    const rows = goalList().filter(g =>
        goalsFilter === 'all' ? true : goalsFilter === 'done' ? goalDone(g) : !goalDone(g));

    if (!rows.length) {
        list.innerHTML = `<div class="goals-empty">${goalsFilter === 'done'
            ? 'Nothing reached yet — keep going.'
            : goalsFilter === 'open'
                ? 'No goals on the go. Add one and start putting money aside for it.'
                : 'No goals yet. A goal can be anything you are saving toward — an emergency fund, next year’s tuition, a new phone.'
            }</div>`;
        return;
    }

    list.innerHTML = rows.map(g => {
        const saved = goalSaved(g), target = goalTarget(g), left = goalLeft(g);
        const pct = target > 0 ? Math.min(saved / target * 100, 100) : 0;
        const st = goalStatus(g);
        const monthly = goalMonthly(g);
        const days = g.targetDate ? daysUntil(g.targetDate) : null;
        const contribs = goalDeposits(g.id);

        const meta = [
            g.note ? vizEsc(g.note) : '',
            `${contribs.length} deposit${contribs.length === 1 ? '' : 's'}`,
            g.targetDate ? `by ${vizEsc(isoToLabel(g.targetDate))}` : ''
        ].filter(Boolean).join(' · ');

        let pace = '';
        if (goalDone(g)) {
            pace = `<div class="goal-pace">Fully funded. Anything you spend it on can be logged as a normal
                expense — the goal stays here as a record.</div>`;
        } else if (monthly !== null) {
            pace = `<div class="goal-pace">Put aside <strong>${valuesHidden ? mask() : fmt(monthly)}</strong> a month
                to reach this by ${vizEsc(isoToLabel(g.targetDate))}${days !== null ? ` — ${days} day${days === 1 ? '' : 's'} to go` : ''}.</div>`;
        } else if (days !== null && days < 0) {
            pace = `<div class="goal-pace">The date has passed with <strong>${valuesHidden ? mask() : fmt(left)}</strong>
                still to save. Move the date, or lower the target.</div>`;
        } else if (target > 0) {
            pace = `<div class="goal-pace"><strong>${valuesHidden ? mask() : fmt(left)}</strong> to go. Give this goal
                a date and the tracker will work out the monthly amount.</div>`;
        }

        const recent = contribs.length ? `<div class="goal-contribs">${contribs.slice(0, 5).map(x =>
            `<div class="goal-contrib"><span>${vizEsc(x.date)} · ${vizEsc(x.source)}</span>
                <span>${valuesHidden ? mask() : fmt(x.amount)}</span></div>`).join('')
            }${contribs.length > 5
                ? `<div class="goal-contrib"><span>+ ${contribs.length - 5} earlier deposit${contribs.length - 5 === 1 ? '' : 's'}</span><span></span></div>`
                : ''}</div>` : '';

        return `<div class="goal-card${st.card}">
            <div class="goal-card-top">
                <div style="min-width:0">
                    <div class="goal-name">${vizEsc(g.name)}
                        <span class="goal-status${st.cls}">${st.label}</span></div>
                    <div class="goal-meta">${meta}</div>
                </div>
                <div class="goal-amounts">
                    <span class="goal-saved">${valuesHidden ? mask() : fmt(saved)}</span>
                    <span class="goal-of">${goalDone(g) ? 'target reached' : 'of ' + (valuesHidden ? mask() : fmt(target))}</span>
                </div>
            </div>
            <div class="goal-progress">
                <div class="goal-progress-fill${st.fill}" style="width:${pct}%"></div>
            </div>
            <div class="goal-progress-meta">
                <span>${goalDone(g) ? 'Complete' : (valuesHidden ? mask() : fmt(left)) + ' to go'}</span>
                <span>${pct.toFixed(0)}%</span>
            </div>
            ${pace}${recent}
            <div class="goal-actions">
                ${goalDone(g) ? '' : `<button class="goal-btn primary" onclick="openGoalAdd('${g.id}')">Put money in</button>`}
                <button class="goal-btn" onclick="openGoalForm('${g.id}')">Edit</button>
                <button class="goal-btn" onclick="deleteGoal('${g.id}')">Delete</button>
            </div>
        </div>`;
    }).join('');
}

/* ── add / edit a goal ── */
function openGoalForm(id) {
    editingGoalId = id || null;
    const g = id ? findGoalById(id) : null;
    setText('goalFormTitle', g ? 'Edit goal' : 'Add a goal');
    document.getElementById('goalName').value = g ? g.name : '';
    document.getElementById('goalTarget').value = g ? g.target : '';
    document.getElementById('goalDate').value = g && g.targetDate ? g.targetDate : '';
    document.getElementById('goalNote').value = g && g.note ? g.note : '';
    document.getElementById('goalFormModal').classList.add('open');
    setTimeout(() => document.getElementById('goalName').focus(), 100);
}
function closeGoalForm() { document.getElementById('goalFormModal').classList.remove('open'); editingGoalId = null }
function saveGoalForm() {
    const name = document.getElementById('goalName').value.trim();
    const target = parseFloat(document.getElementById('goalTarget').value);
    const targetDate = document.getElementById('goalDate').value || '';
    const note = document.getElementById('goalNote').value.trim();
    if (!name) { showToast('Give the goal a name'); return }
    if (isNaN(target) || target <= 0) { showToast('Enter how much you need'); return }
    if (editingGoalId) {
        const g = findGoalById(editingGoalId); if (!g) return;
        g.name = name; g.target = target; g.targetDate = targetDate; g.note = note;
    } else {
        goalList().unshift({ id: uid(), name, target, targetDate, note, createdAt: Date.now() });
    }
    save(); closeGoalForm(); renderGoalBadge(); refreshGoalSelects();
    if (goalsIsOpen()) renderGoals();
    showToast(editingGoalId ? 'Goal updated ✓' : `${name} added ✓`);
}
function deleteGoal(id) {
    const g = findGoalById(id); if (!g) return;
    const contribs = goalDeposits(id);
    const msg = contribs.length
        ? `Delete "${g.name}"? Its ${contribs.length} deposit${contribs.length === 1 ? '' : 's'} stay in your records — the money has already left the account — but will no longer be tied to a goal.`
        : `Delete "${g.name}"?`;
    if (!confirm(msg)) return;
    state.categories.forEach(cat => (cat.expenses || []).forEach(e => { if (e.goalId === id) delete e.goalId }));
    (state.moneyIn || []).forEach(e => { if (isSetAside(e) && e.goalId === id) delete e.goalId });
    state.goals = goalList().filter(x => x.id !== id);
    save(); render(); renderGoalBadge(); refreshGoalSelects();
    if (goalsIsOpen()) renderGoals();
    showToast('Goal deleted');
}

/* ── putting money in ── */
/* Money can come out of a category's allowance, or straight out of the
   excess — whatever this account holds that this month's categories have
   not claimed. The excess is only offered when there actually is some. */
const GOAL_FROM_EXCESS = '__excess__';
function accountExcess() {
    return (Number(state.totalBudget) || 0) - totalSpentAll() - catTotalRem();
}
function goalCatOptions(selected) {
    const excess = accountExcess();
    const cats = state.categories.map(c => {
        const left = Math.max(0, catBudget(c, activePeriod) - catSpent(c, activePeriod));
        return `<option value="${c.id}"${c.id === selected ? ' selected' : ''}>${vizEsc(c.name)} — ${vizEsc(valuesHidden ? mask() : fmt(left))} left</option>`;
    }).join('');
    if (excess <= 0.005) return cats;
    return `<option value="${GOAL_FROM_EXCESS}"${selected === GOAL_FROM_EXCESS || !selected ? ' selected' : ''}>Excess money — ${vizEsc(valuesHidden ? mask() : fmt(excess))} unallocated</option>` + cats;
}
function openGoalAdd(id) {
    const g = findGoalById(id); if (!g) return;
    contribGoalId = id;
    setText('goalAddTitle', 'Put money into ' + g.name);
    const left = goalLeft(g);
    document.getElementById('goalAddHint').textContent =
        `${valuesHidden ? mask() : fmt(left)} still to save toward ${valuesHidden ? mask() : fmt(goalTarget(g))}.`;
    const options = goalCatOptions(g.lastCatId || '');
    if (!options) {
        showToast('Add a category, or some money to this account, first');
        contribGoalId = null; return;
    }
    document.getElementById('goalAddAmount').value = '';
    document.getElementById('goalAddNote').value = g.name;
    document.getElementById('goalAddDate').value = periodDefaultDate();
    /* remember where it came from last time — most people use the same source */
    document.getElementById('goalAddCat').innerHTML = options;
    document.getElementById('goalAddModal').classList.add('open');
    setTimeout(() => document.getElementById('goalAddAmount').focus(), 100);
}
function closeGoalAdd() { document.getElementById('goalAddModal').classList.remove('open'); contribGoalId = null }
function saveGoalAdd() {
    const g = findGoalById(contribGoalId); if (!g) return;
    const amount = parseFloat(document.getElementById('goalAddAmount').value);
    const note = document.getElementById('goalAddNote').value.trim();
    const dateISO = document.getElementById('goalAddDate').value;
    let catId = document.getElementById('goalAddCat').value;
    if (isNaN(amount) || amount <= 0) { showToast('Enter a valid amount'); return }
    if (!note) { showToast('Add a note'); return }
    if (!dateISO) { showToast('Pick a date'); return }
    if (!catId) { showToast('Choose where the money comes from'); return }

    if (catId === GOAL_FROM_EXCESS) {
        /* Straight out of the excess: no category allowance is touched, so
           the money leaves the account balance itself — the same shape as a
           transfer out, and undone the same way from Add Money. */
        if (!state.moneyIn) state.moneyIn = [];
        state.moneyIn.unshift({
            id: uid(), note, amount, kind: 'saving', dir: 'out', goalId: g.id,
            date: isoToLabel(dateISO), dateRaw: dateISO, loggedAt: Date.now()
        });
        state.totalBudget = (Number(state.totalBudget) || 0) - amount;
    } else {
        const cat = state.categories.find(c => c.id === catId);
        if (!cat) { showToast('Pick where the money comes from'); return }
        cat.expenses.unshift({
            id: uid(), note, amount, type: 'spent', goalId: g.id,
            date: isoToLabel(dateISO), dateRaw: dateISO, loggedAt: Date.now()
        });
    }
    g.lastCatId = catId;
    const reached = goalDone(g);
    save(); closeGoalAdd(); render(); renderGoalBadge();
    if (goalsIsOpen()) renderGoals();
    const landed = periodKeyFromISO(dateISO);
    if (reached) showToast(`${g.name} fully funded ✓`);
    else if (landed !== activePeriod) showToast(`Saved to ${periodLabel(landed)} — switch months to see it`);
    else showToast('Put aside ✓');
}

/* ── linking an existing entry to a goal, from the edit form ── */
function goalOptionsHtml(selectedId) {
    const opts = goalList().map(g =>
        `<option value="${g.id}"${g.id === selectedId ? ' selected' : ''}>${vizEsc(g.name)}${goalDone(g) ? ' (reached)' : ''}</option>`).join('');
    return `<option value=""${selectedId ? '' : ' selected'}>Not part of a goal</option>${opts}`;
}
function refreshGoalSelects() {
    const sel = document.getElementById('editGoalPick');
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = goalOptionsHtml(keep);
    sel.value = keep;
    const wrap = document.getElementById('editGoalFields');
    if (wrap) wrap.style.display = goalList().length ? 'block' : 'none';
}

/* ════════ 4. CASH FLOW — money in against money out ════════

   Two series over the same months, so they are told apart by the
   validated categorical slots rather than by the app's green/red:
   that pair measures ΔE 2.3 under deutan simulation, which is to say
   a red-green colourblind reader could not tell the columns apart.
   Slot 1 and slot 2 clear ΔE 9. In is always the left column of a
   pair and out the right, and both are named in the legend, so hue
   is never the only thing carrying it.

   Underneath, a second small panel shows the month's net on its own
   scale — the two panels share an x axis and each labels its own y,
   the honest alternative to stacking two scales on one plot.

   Transfers count here: money moved to the other account really has
   left this one. */
function vizCashFlow(period) {
    let inn = 0, out = 0;
    state.categories.forEach(c => (c.expenses || []).forEach(e => {
        if (periodOf(e) === period) out += Number(e.amount) || 0;
    }));
    (state.moneyIn || []).forEach(e => {
        const k = e.dateRaw ? periodKeyFromISO(e.dateRaw) : parseFallbackKey(e.date);
        if (k !== period) return;
        const amt = Number(e.amount) || 0;
        if (isOutflowEntry(e)) { if (e.dir === 'out') out += amt; else inn += amt }
        else inn += amt;
    });
    return { in: inn, out: out, net: inn - out };
}
/* a column with a 4px rounded data-end and a square baseline; `up`
   says which way it grows from the baseline */
function vizColPath(x, yBase, w, h, up) {
    if (h <= 0.5) return '';
    const r = Math.min(4, w / 2, h);
    const x0 = x.toFixed(1), x1 = (x + r).toFixed(1);
    const x2 = (x + w - r).toFixed(1), x3 = (x + w).toFixed(1);
    const b = yBase.toFixed(1);
    if (up) {
        const top = yBase - h;
        return `M${x0} ${b}V${(top + r).toFixed(1)}Q${x0} ${top.toFixed(1)} ${x1} ${top.toFixed(1)}` +
            `H${x2}Q${x3} ${top.toFixed(1)} ${x3} ${(top + r).toFixed(1)}V${b}Z`;
    }
    const bot = yBase + h;
    return `M${x0} ${b}V${(bot - r).toFixed(1)}Q${x0} ${bot.toFixed(1)} ${x1} ${bot.toFixed(1)}` +
        `H${x2}Q${x3} ${bot.toFixed(1)} ${x3} ${(bot - r).toFixed(1)}V${b}Z`;
}
function vizFlowHtml() {
    const keys = vizTrendPeriods();
    const pts = keys.map(k => Object.assign({ key: k }, vizCashFlow(k)));
    if (!pts.some(p => p.in > 0.005 || p.out > 0.005)) {
        return '<div class="viz-empty">Nothing has come in or gone out yet.</div>';
    }

    const W = 640, padL = 56, padR = 20, padT = 16;
    const barsH = 150, gapH = 14, netH = 74, labelH = 26;
    const H = padT + barsH + gapH + netH + labelH;
    const plotW = W - padL - padR;
    const base = padT + barsH;                        /* the columns' baseline */

    const ticks = vizTicks(Math.max(...pts.map(p => Math.max(p.in, p.out))), 3);
    const top = ticks[ticks.length - 1] || 1;

    /* The net panel's zero line sits wherever the data needs it: at the
       foot when every month finished ahead, at the head when none did,
       and in proportion when it is a mix — so the bars always use the
       whole strip and the line still means exactly zero. */
    const netHigh = Math.max(0, ...pts.map(p => p.net));
    const netLow = Math.min(0, ...pts.map(p => p.net));
    const netSpan = (netHigh - netLow) || 1;
    const netTop = base + gapH + 14;                  /* 14px for the panel caption */
    const netUsable = netH - 18;
    const netMid = netTop + (netHigh / netSpan) * netUsable;
    const netPx = v => (Math.abs(v) / netSpan) * netUsable;

    const band = plotW / pts.length;
    const colW = Math.max(4, Math.min(24, (band - 12) / 2));
    const centre = i => padL + band * (i + 0.5);

    const grid = ticks.map(t => {
        const y = base - (t / top) * barsH;
        return `<line class="viz-grid-line" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}"></line>
            <text class="viz-tick" x="${padL - 9}" y="${(y + 3.5).toFixed(1)}" text-anchor="end">${vizEsc(vizCompact(t))}</text>`;
    }).join('');

    const hooks = 'onmouseenter="vizShowTip(event)" onfocus="vizShowTip(event)" ' +
        'onmouseleave="vizHideTip()" onblur="vizHideTip()"';

    const cols = pts.map((p, i) => {
        const c = centre(i);
        /* the 2px gap of plain surface between the pair does the separating */
        const xIn = c - colW - 1, xOut = c + 1;
        const hIn = (p.in / top) * barsH, hOut = (p.out / top) * barsH;
        return `<path d="${vizColPath(xIn, base, colW, hIn, true)}" fill="var(--series-1)"></path>
            <path d="${vizColPath(xOut, base, colW, hOut, true)}" fill="var(--series-2)"></path>
            <rect class="viz-hit" x="${(c - band / 2).toFixed(1)}" y="${padT}" width="${band.toFixed(1)}" height="${barsH}"
                tabindex="0" role="img"
                data-viz-val="${vizEsc(vizNum(p.in))} in"
                data-viz-name="${vizEsc(periodLabel(p.key))}"
                data-viz-color="var(--series-1)"
                data-viz-extra="${vizEsc(vizNum(p.out))} out · net ${p.net < 0 ? '−' : '+'}${vizEsc(vizNum(Math.abs(p.net)))}"
                aria-label="${vizEsc(periodLabel(p.key))}: ${vizEsc(vizNum(p.in))} in, ${vizEsc(vizNum(p.out))} out, net ${p.net < 0 ? 'minus ' : 'plus '}${vizEsc(vizNum(Math.abs(p.net)))}"
                ${hooks}></rect>`;
    }).join('');

    const netBars = pts.map((p, i) => {
        const c = centre(i);
        const w = Math.max(4, Math.min(28, band - 14));
        const up = p.net >= 0;
        return `<path d="${vizColPath(c - w / 2, netMid, w, netPx(p.net), up)}"
            fill="${up ? 'var(--series-1)' : 'var(--series-2)'}"></path>`;
    }).join('');

    /* label only the latest month's net — the rest is in the tooltip and the table */
    const last = pts[pts.length - 1];
    const lastUp = last.net >= 0;
    const netLabel = `<text class="viz-mark-label strong" x="${centre(pts.length - 1).toFixed(1)}"
        y="${(netMid + (lastUp ? -netPx(last.net) - 5 : netPx(last.net) + 12)).toFixed(1)}"
        text-anchor="middle">${last.net < 0 ? '−' : '+'}${vizEsc(vizCompact(Math.abs(last.net)))}</text>`;

    const every = pts.length > 8 ? 2 : 1;
    const xLabels = pts.map((p, i) => {
        if (i % every !== 0 && i !== pts.length - 1) return '';
        const mm = p.key.slice(5);
        return `<text class="viz-tick" x="${centre(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${MONTHS_SHORT[parseInt(mm) - 1]}${mm === '01' || i === 0 ? ' ’' + p.key.slice(2, 4) : ''}</text>`;
    }).join('');

    const totalIn = pts.reduce((s, p) => s + p.in, 0);
    const totalOut = pts.reduce((s, p) => s + p.out, 0);
    const net = totalIn - totalOut;

    return `<div class="viz-flow-tiles">
        <div class="viz-tile"><span class="viz-tile-label"><span class="viz-tile-key" style="background:var(--series-1)"></span>Money in</span>
            <span class="viz-tile-value">${vizEsc(vizNum(totalIn))}</span></div>
        <div class="viz-tile"><span class="viz-tile-label"><span class="viz-tile-key" style="background:var(--series-2)"></span>Money out</span>
            <span class="viz-tile-value">${vizEsc(vizNum(totalOut))}</span></div>
        <div class="viz-tile"><span class="viz-tile-label">Net over ${pts.length} month${pts.length === 1 ? '' : 's'}</span>
            <span class="viz-tile-value">${net < 0 ? '−' : '+'}${vizEsc(vizNum(Math.abs(net)))}</span></div>
    </div>
    <div class="viz-scroll"><svg class="viz-svg" viewBox="0 0 ${W} ${H}" style="min-width:480px"
            role="group" aria-label="Money in against money out, month by month, with the net below">
        ${grid}
        ${cols}
        <line class="viz-axis-line" x1="${padL}" y1="${base}" x2="${W - padR}" y2="${base}"></line>

        <text class="viz-center-label" x="${padL}" y="${(netTop - 5).toFixed(1)}"
            style="fill:var(--text-soft)">Net each month</text>
        ${netHigh > 0 ? `<text class="viz-tick" x="${padL - 9}" y="${(netTop + 4).toFixed(1)}" text-anchor="end">${vizEsc(vizCompact(netHigh))}</text>` : ''}
        ${netLow < 0 ? `<text class="viz-tick" x="${padL - 9}" y="${(netTop + netUsable + 4).toFixed(1)}" text-anchor="end">−${vizEsc(vizCompact(Math.abs(netLow)))}</text>` : ''}
        <text class="viz-tick" x="${padL - 9}" y="${(netMid + 3.5).toFixed(1)}" text-anchor="end">0</text>
        ${netBars}${netLabel}
        <line class="viz-axis-line" x1="${padL}" y1="${netMid}" x2="${W - padR}" y2="${netMid}"></line>
        ${xLabels}
    </svg></div>
    <div class="viz-key">
        <span class="viz-key-item"><span class="viz-key-swatch" style="background:var(--series-1)"></span>Money in</span>
        <span class="viz-key-item"><span class="viz-key-swatch" style="background:var(--series-2)"></span>Money out</span>
        <span class="viz-key-item">Transfers to your other account count as money out.</span>
    </div>`;
}

/* ════════════════════════════════════════════════════════════════
   KEYBOARD & ACCESSIBILITY FOR MODALS

   Every dialogue in here is opened and closed by adding or removing
   one class, from nineteen different places. Rather than teach each
   of them about focus and keyboards, this watches the class itself:
   whatever opens a dialogue, the behaviour below follows.

   What it adds:
     · Esc closes the top dialogue, through its own close function so
       the state it keeps (editingId and friends) is still cleared
     · Tab and Shift+Tab stay inside the dialogue
     · Clicking the dimmed backdrop closes it — but only when the
       press and the release both land there, so selecting text and
       drifting off the edge does not dismiss your work
     · Focus moves into the dialogue on open and returns to whatever
       you were on when it closes
     · role="dialog", aria-modal and a label taken from its heading
     · everything behind is made inert, so a screen reader and the
       Tab key cannot wander into the page underneath
   ════════════════════════════════════════════════════════════════ */

/* id → the function that closes it properly */
const MODAL_CLOSERS = {
    addMoneyModal: closeAddMoney,
    pinModal: closePinModal,
    settingsModal: closeSettings,
    loansModal: closeLoans,
    loanFormModal: closeLoanForm,
    transferModal: closeTransfer,
    manualModal: closeManual,
    editMoneyModal: closeEditMoney,
    editModal: closeEditModal,
    goalsModal: closeGoals,
    goalFormModal: closeGoalForm,
    goalAddModal: closeGoalAdd,
    chartsModal: closeCharts,
    reportModal: closeReport,
    logsModal: closeLogs,
    backupModal: closeBackup,
    addCatBudgetModal: closeAddCatBudget,
    deductCatBudgetModal: closeDeductCatBudget,
    editExpModal: closeEditExpModal
};

const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])'
].join(',');

/* where focus was when each dialogue opened, so it can be given back */
const modalReturnFocus = new Map();

/* every overlay wraps exactly one panel, whatever that panel is called
   (.modal, .settings-modal, .charts-modal, …) */
function modalPanel(overlay) {
    return overlay.firstElementChild || overlay;
}
function openModals() {
    return Array.from(document.querySelectorAll('.modal-overlay.open'));
}
/* The one on top is the one opened most recently — NOT the last in
   document order. Those differ: a dialog opened from another dialog is
   raised with z-index, but it may sit earlier in the markup (the PIN
   dialog is written above Settings yet opens on top of it). Reading the
   order from the document made the code mark the visible dialog inert,
   which blocks every click and keypress in it. */
const modalStack = [];
function topModal() {
    for (let i = modalStack.length - 1; i >= 0; i--) {
        if (modalStack[i].classList.contains('open')) return modalStack[i];
    }
    /* nothing tracked yet — fall back to document order */
    const all = openModals();
    return all.length ? all[all.length - 1] : null;
}
function modalFocusables(overlay) {
    return Array.from(modalPanel(overlay).querySelectorAll(FOCUSABLE))
        .filter(el => el.offsetParent !== null || el === document.activeElement);
}

/* Label the dialogue from its own heading. Done once, lazily, so the
   markup does not have to repeat it nineteen times. */
function describeModal(overlay) {
    const panel = modalPanel(overlay);
    if (panel.getAttribute('role') === 'dialog') return;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('tabindex', '-1');
    const heading = panel.querySelector('h3, h2');
    if (heading) {
        if (!heading.id) heading.id = overlay.id + 'Heading';
        panel.setAttribute('aria-labelledby', heading.id);
    } else {
        panel.setAttribute('aria-label', 'Dialog');
    }
}

/* Recomputed from scratch every time so it can never get stuck: the
   page behind the top dialogue is inert, everything else is not. */
function syncModalBackground() {
    const top = topModal();
    const supportsInert = 'inert' in HTMLElement.prototype;
    Array.from(document.body.children).forEach(el => {
        /* the toast and the storage alert still need to be announced */
        if (el.id === 'toast' || el.id === 'storageAlert' || el.id === 'printSheet' || el.id === 'printFrame') return;
        const shouldBlock = !!top && el !== top;
        if (supportsInert) el.inert = shouldBlock;
        else if (shouldBlock) el.setAttribute('aria-hidden', 'true');
        else el.removeAttribute('aria-hidden');
    });
    document.body.classList.toggle('modal-open', !!top);
}

function onModalOpened(overlay) {
    const at = modalStack.indexOf(overlay);
    if (at >= 0) modalStack.splice(at, 1);
    modalStack.push(overlay);
    describeModal(overlay);
    modalReturnFocus.set(overlay.id, document.activeElement);
    syncModalBackground();
    /* several dialogues focus their own first field on a timer; only
       step in if nothing inside has taken focus by then */
    setTimeout(() => {
        if (!overlay.classList.contains('open')) return;
        if (overlay.contains(document.activeElement)) return;
        const first = modalFocusables(overlay)[0];
        (first || modalPanel(overlay)).focus();
    }, 140);
}
function onModalClosed(overlay) {
    const at = modalStack.indexOf(overlay);
    if (at >= 0) modalStack.splice(at, 1);
    syncModalBackground();
    const back = modalReturnFocus.get(overlay.id);
    modalReturnFocus.delete(overlay.id);
    /* locking sweeps every dialogue shut; focus must stay on the lock
       screen rather than being handed back to the page behind it */
    if (isLocked()) return;
    /* give focus back to whatever opened it, as long as it is still there */
    if (back && document.contains(back) && back.offsetParent !== null) {
        try { back.focus({ preventScroll: true }) } catch (e) { back.focus() }
    } else {
        const still = topModal();
        if (still) (modalFocusables(still)[0] || modalPanel(still)).focus();
    }
}

/* one observer per overlay, watching only the class attribute */
function watchModals() {
    document.querySelectorAll('.modal-overlay').forEach(overlay => {
        let wasOpen = overlay.classList.contains('open');
        new MutationObserver(() => {
            const isOpen = overlay.classList.contains('open');
            if (isOpen === wasOpen) return;
            wasOpen = isOpen;
            if (isOpen) onModalOpened(overlay); else onModalClosed(overlay);
        }).observe(overlay, { attributes: true, attributeFilter: ['class'] });

        /* backdrop click — press and release must both land on the backdrop */
        let pressedBackdrop = false;
        overlay.addEventListener('mousedown', ev => { pressedBackdrop = ev.target === overlay });
        overlay.addEventListener('click', ev => {
            if (ev.target === overlay && pressedBackdrop) closeTopModal();
            pressedBackdrop = false;
        });
    });
}

function closeTopModal() {
    const top = topModal(); if (!top) return false;
    const close = MODAL_CLOSERS[top.id];
    if (close) close(); else top.classList.remove('open');
    return true;
}

/* Tab must not walk out of the dialogue */
function trapModalTab(ev) {
    const top = topModal(); if (!top) return;
    const items = modalFocusables(top);
    if (!items.length) { ev.preventDefault(); modalPanel(top).focus(); return }
    const first = items[0], last = items[items.length - 1];
    const here = document.activeElement;
    if (!top.contains(here)) { ev.preventDefault(); (ev.shiftKey ? last : first).focus(); return }
    if (ev.shiftKey && here === first) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && here === last) { ev.preventDefault(); first.focus() }
}

document.addEventListener('keydown', ev => {
    /* the lock screen has its own keypad and must not be escapable */
    if (isLocked()) return;
    if (ev.key === 'Escape') {
        const menu = document.getElementById('dataMenu');
        if (menu && menu.classList.contains('open')) { closeDataMenu(); ev.preventDefault(); return }
        if (closeTopModal()) ev.preventDefault();
        return;
    }
    if (ev.key === 'Tab') trapModalTab(ev);
});

/* the Data ▾ menu closes on an outside click like any other popover */
document.addEventListener('mousedown', ev => {
    const wrap = document.getElementById('dataDropdown');
    const menu = document.getElementById('dataMenu');
    if (menu && menu.classList.contains('open') && wrap && !wrap.contains(ev.target)) closeDataMenu();
});

watchModals();
syncModalBackground();

/* ════════════════════════════════════════════════════════════════
   ORDERING CATEGORIES

   Four orders: the one you arranged yourself, by name, by what is
   left, and by what you have spent. Only "My order" is a property of
   the data — the other three are a view over it, so switching to
   Name and back never loses the arrangement you dragged out.

   Dragging is done with pointer events rather than HTML5 drag-and-
   drop, which does not exist on touch. It starts from the grip alone,
   so scrolling a long list and tapping a card still behave normally,
   and the grip is a real button: focus it and the arrow keys move
   the card without a pointer at all.
   ════════════════════════════════════════════════════════════════ */

function catSort() { return settings().catSort || 'custom' }
function catSortDir() { return settings().catSortDir === 'desc' ? 'desc' : 'asc' }
function setCatSort(mode) {
    const st = settings();
    /* asking for the same order again just flips it */
    if (st.catSort === mode && mode !== 'custom') st.catSortDir = catSortDir() === 'asc' ? 'desc' : 'asc';
    else {
        st.catSort = mode;
        /* the useful first look differs per column: A–Z, but biggest-first
           for money */
        st.catSortDir = mode === 'name' ? 'asc' : mode === 'custom' ? 'asc' : 'desc';
    }
    save(); render();
}
function toggleCatSortDir() {
    const st = settings();
    st.catSortDir = catSortDir() === 'asc' ? 'desc' : 'asc';
    save(); render();
}
function sortedCategories() {
    const mode = catSort();
    if (mode === 'custom') return state.categories.slice();
    const dir = catSortDir() === 'desc' ? -1 : 1;
    const key = c => {
        if (mode === 'name') return null;
        const st = catStats(c);
        return mode === 'remaining' ? st.rem : st.spent;
    };
    return state.categories.slice().sort((a, b) => {
        if (mode === 'name') return dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        const d = key(a) - key(b);
        /* ties fall back to the name, so the list never shuffles at random */
        return d !== 0 ? dir * d : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
}
function renderCatSortBar() {
    const bar = document.getElementById('catSortBar'); if (!bar) return;
    bar.style.display = state.categories.length > 1 ? '' : 'none';
    const mode = catSort();
    bar.querySelectorAll('.cat-sort-btn').forEach(b => {
        const on = b.dataset.sort === mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const dirBtn = document.getElementById('catSortDir');
    if (dirBtn) {
        dirBtn.style.display = mode === 'custom' ? 'none' : '';
        dirBtn.textContent = catSortDir() === 'asc' ? '↓' : '↑';
        dirBtn.title = catSortDir() === 'asc'
            ? (mode === 'name' ? 'A to Z — tap for Z to A' : 'Smallest first — tap for largest first')
            : (mode === 'name' ? 'Z to A — tap for A to Z' : 'Largest first — tap for smallest first');
        dirBtn.setAttribute('aria-label', dirBtn.title);
    }
}

/* ── moving one category to a new position ── */
function moveCategory(id, toIndex) {
    const from = state.categories.findIndex(c => c.id === id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(state.categories.length - 1, toIndex));
    if (to === from) return false;
    const [item] = state.categories.splice(from, 1);
    state.categories.splice(to, 0, item);
    save();
    return true;
}
/* arrow keys on the grip — the pointer-free way to arrange */
function gripKey(ev, id) {
    const up = ev.key === 'ArrowUp', down = ev.key === 'ArrowDown';
    if (!up && !down) return;
    ev.preventDefault(); ev.stopPropagation();
    if (catSort() !== 'custom') {
        showToast('Switch to “My order” to arrange them yourself');
        return;
    }
    const at = state.categories.findIndex(c => c.id === id);
    if (!moveCategory(id, at + (up ? -1 : 1))) return;
    render();
    /* keep the grip under the finger, so it can be pressed again */
    const grip = document.querySelector(`[data-grip="${id}"]`);
    if (grip) { grip.focus(); grip.scrollIntoView({ block: 'nearest' }) }
}

/* ── drag ── */
let dragState = null;
function catCards() { return Array.from(document.querySelectorAll('#categoriesList .cat-card')) }

function dragStart(ev) {
    const grip = ev.target.closest('[data-grip]');
    if (!grip || ev.button > 0) return;
    if (catSort() !== 'custom') { showToast('Switch to “My order” to arrange them yourself'); return }

    const card = grip.closest('.cat-card'); if (!card) return;
    ev.preventDefault();

    const rect = card.getBoundingClientRect();
    /* a tall, expanded card makes an unwieldy thing to drag, so what
       follows the pointer is a short copy of its header only */
    const ghost = card.cloneNode(true);
    ghost.classList.add('cat-ghost');
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    const body = ghost.querySelector('.cat-body'); if (body) body.remove();
    document.body.appendChild(ghost);

    card.classList.add('cat-dragging');
    document.body.classList.add('cat-reordering');

    dragState = {
        id: card.dataset.cat, card, ghost,
        offsetY: ev.clientY - rect.top,
        pointerId: ev.pointerId
    };
    grip.setPointerCapture(ev.pointerId);
    grip.addEventListener('pointermove', dragMove);
    grip.addEventListener('pointerup', dragEnd);
    grip.addEventListener('pointercancel', dragEnd);
}
function dragMove(ev) {
    if (!dragState) return;
    ev.preventDefault();
    const g = dragState.ghost;
    g.style.top = (ev.clientY - dragState.offsetY) + 'px';

    /* drop where the pointer is: the first card whose middle is below it */
    const others = catCards().filter(c => c !== dragState.card);
    let before = null;
    for (const c of others) {
        const r = c.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { before = c; break }
    }
    const list = document.getElementById('categoriesList');
    if (before) { if (dragState.card.nextElementSibling !== before) list.insertBefore(dragState.card, before) }
    else if (list.lastElementChild !== dragState.card) list.appendChild(dragState.card);

    /* keep the list scrolling when the drag reaches an edge */
    const margin = 70;
    if (ev.clientY < margin) window.scrollBy(0, -12);
    else if (ev.clientY > window.innerHeight - margin) window.scrollBy(0, 12);
}
function dragEnd(ev) {
    if (!dragState) return;
    const { id, card, ghost } = dragState;
    const grip = document.querySelector(`[data-grip="${id}"]`);
    if (grip) {
        grip.removeEventListener('pointermove', dragMove);
        grip.removeEventListener('pointerup', dragEnd);
        grip.removeEventListener('pointercancel', dragEnd);
        try { grip.releasePointerCapture(dragState.pointerId) } catch (e) { }
    }
    ghost.remove();
    card.classList.remove('cat-dragging');
    document.body.classList.remove('cat-reordering');
    dragState = null;

    /* the DOM is now in the order the user arranged; write it back */
    const order = catCards().map(c => c.dataset.cat);
    const moved = order.some((catId, i) => state.categories[i] && state.categories[i].id !== catId);
    if (!moved) return;
    state.categories.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    save(); render();
    const grip2 = document.querySelector(`[data-grip="${id}"]`);
    if (grip2) grip2.focus();
    showToast('Order saved ✓');
}
document.addEventListener('pointerdown', dragStart);

/* ════════════════════════════════════════════════════════════════
   APPEARANCE — colour theme, logo, background

   One decision drives the whole palette: a single accent colour. Both
   the light and the dark version of every accent token are derived
   from it, so a theme chosen once is right in both modes rather than
   only in the one that happened to be on screen.

   Derived values are pushed onto the root element as inline custom
   properties. Inline properties beat any stylesheet rule, including
   :root[data-theme="dark"], which is why the values must be
   recomputed whenever the light/dark mode changes — applyTheme()
   calls back into here for exactly that reason.

   Pictures live under their own storage key. A background photo is
   far larger than a year of records, and if the two shared a key a
   picture that would not fit could stop the records saving.
   ════════════════════════════════════════════════════════════════ */

const MEDIA_KEY = 'bank_media';
const MEDIA_LIMIT = 2600000;      /* ~2.6 MB of data URI, well inside a 5 MB store */

/* ── colour maths ── */
function hexToRgb(hex) {
    const h = String(hex || '').replace('#', '').trim();
    const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}
function rgbToHex(r, g, b) {
    const c = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
    return '#' + c(r) + c(g) + c(b);
}
function hexToHsl(hex) {
    const rgb = hexToRgb(hex); if (!rgb) return null;
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}
function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x } else if (h < 120) { r = x; g = c }
    else if (h < 180) { g = c; b = x } else if (h < 240) { g = x; b = c }
    else if (h < 300) { r = x; b = c } else { r = c; b = x }
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
function relLuminance(hex) {
    const rgb = hexToRgb(hex); if (!rgb) return 0;
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) };
    return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}
function contrastRatio(a, b) {
    const la = relLuminance(a), lb = relLuminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
/* walk the lightness until the colour reads against its surface */
function readableOn(hex, surface, target) {
    const hsl = hexToHsl(hex); if (!hsl) return hex;
    const darken = relLuminance(surface) > 0.4;
    let l = hsl.l;
    for (let i = 0; i < 60; i++) {
        const candidate = hslToHex(hsl.h, hsl.s, l);
        if (contrastRatio(candidate, surface) >= target) return candidate;
        l += darken ? -1.5 : 1.5;
        if (l < 4 || l > 96) break;
    }
    return hslToHex(hsl.h, hsl.s, Math.max(4, Math.min(96, l)));
}
function rgbTriplet(hex) {
    const c = hexToRgb(hex);
    return c ? `${c.r}, ${c.g}, ${c.b}` : '0, 0, 0';
}

/* ── the presets ──
   Each is only a hue plus how strong it is; everything else is worked
   out below, so adding a theme means adding one line. */
const THEMES = {
    /* The original look. It sets no colours of its own: choosing it takes
       the inline properties back off the root element, so the stylesheet's
       own values apply exactly as they were written — not a re-derivation
       that lands nearby. Its artwork is the first pair of boards. */
    default: { name: 'Default', accent: '#72383D', ink: '#322D29', stock: true },
    luxe: { name: 'Luxe', accent: '#72383D', ink: '#322D29', warm: true },
    ember: { name: 'Ember', accent: '#A6541F', ink: '#2E2620', warm: true },
    fern: { name: 'Fern', accent: '#3D6B4C', ink: '#232B26', warm: false },
    harbour: { name: 'Harbour', accent: '#2C5F73', ink: '#1F2A30', warm: false },
    indigo: { name: 'Indigo', accent: '#404A85', ink: '#22242F', warm: false },
    plum: { name: 'Plum', accent: '#5F3A6B', ink: '#2A2230', warm: false }
};
const THEME_ORDER = ['default', 'luxe', 'ember', 'fern', 'harbour', 'indigo', 'plum'];
/* every theme that ships its own Canva boards — the stock one is left out
   so a custom colour borrows one of those rather than the original pair */
const THEME_ART = THEME_ORDER.filter(k => !THEMES[k].stock);

function themeKey() {
    const t = settings().theme;
    return (t === 'custom' || THEMES[t]) ? t : DEFAULT_SETTINGS.theme;
}
function themeAccent() {
    const key = themeKey();
    if (key === 'custom') {
        const c = settings().accent;
        return hexToRgb(c) ? c : THEMES.luxe.accent;
    }
    return THEMES[key].accent;
}
/* Every preset ships a pair of backdrop boards. A custom colour has no
   board of its own, so it borrows the one whose hue is nearest — better
   than a warm backdrop sitting under a cold accent. */
function themeArtKey() {
    const key = themeKey();
    if (key !== 'custom') return key;
    const hsl = hexToHsl(themeAccent());
    if (!hsl) return 'luxe';
    let best = 'luxe', bestGap = 999;
    THEME_ART.forEach(k => {
        const h = hexToHsl(THEMES[k].accent);
        if (!h) return;
        const gap = Math.min(Math.abs(h.h - hsl.h), 360 - Math.abs(h.h - hsl.h));
        if (gap < bestGap) { bestGap = gap; best = k }
    });
    return best;
}
function themeArtUrl(mode) {
    const key = themeArtKey();
    /* the original theme's boards were never named after it */
    if (key === 'default') return 'Background/' + (mode === 'dark' ? '2' : '1') + '.png';
    return 'Background/' + key + '-' + (mode === 'dark' ? 'dark' : 'light') + '.png';
}
function themeInk() {
    const key = themeKey();
    if (key !== 'custom') return THEMES[key].ink;
    /* a custom ink: the accent's hue, taken almost to black */
    const hsl = hexToHsl(themeAccent()) || { h: 20, s: 10 };
    return hslToHex(hsl.h, Math.min(14, hsl.s * 0.35), 17);
}

/* Every accent token, for one mode. The two "fill" tokens stay dark in
   both modes because white type sits on them. */
function accentTokens(base, mode) {
    const hsl = hexToHsl(base) || { h: 350, s: 34, l: 33 };
    const dark = mode === 'dark';
    const surface = dark ? '#24201D' : '#FFFFFF';
    /* the readable accent for text and icons on this mode's surface */
    const accent = readableOn(hslToHex(hsl.h, hsl.s, dark ? 66 : hsl.l), surface, 4.5);
    const accent2 = hslToHex(hsl.h, hsl.s, dark ? 56 : Math.min(96, hsl.l + 9));
    const soft = hslToHex(hsl.h, dark ? Math.min(24, hsl.s) : Math.min(38, hsl.s), dark ? 16 : 95);
    const border = hslToHex(hsl.h, dark ? Math.min(22, hsl.s) : Math.min(30, hsl.s), dark ? 25 : 86);
    const fill = hslToHex(hsl.h, Math.max(hsl.s, 24), Math.min(38, Math.max(24, hsl.l)));
    const fill2 = hslToHex(hsl.h, Math.max(hsl.s, 26), Math.min(30, Math.max(17, hsl.l - 8)));
    return {
        '--accent': accent,
        '--accent-2': accent2,
        '--accent-soft': soft,
        '--accent-border': border,
        '--accent-rgb': rgbTriplet(accent),
        '--accent-fill': fill,
        '--accent-fill-2': fill2,
        '--accent-fg': '#FBF7F5'
    };
}
/* the permanently dark panels — header, budget card, lock screen */
function inkTokens(inkHex) {
    const hsl = hexToHsl(inkHex) || { h: 25, s: 8, l: 18 };
    return {
        '--ink': hslToHex(hsl.h, hsl.s, hsl.l),
        '--ink-2': hslToHex(hsl.h, hsl.s, hsl.l + 6),
        '--ink-3': hslToHex(hsl.h, hsl.s, Math.max(4, hsl.l - 5))
    };
}
/* the page behind everything, barely tinted so text contrast is untouched */
function surfaceTokens(base, mode) {
    const hsl = hexToHsl(base) || { h: 25, s: 10 };
    if (mode === 'dark') {
        return {
            '--bg': hslToHex(hsl.h, 6, 9.5),
            '--bg-2': hslToHex(hsl.h, 6, 12),
            '--surface': hslToHex(hsl.h, 5, 13),
            '--surface-2': hslToHex(hsl.h, 5, 15.5),
            '--surface-3': hslToHex(hsl.h, 5, 18.5)
        };
    }
    return {
        '--bg': hslToHex(hsl.h, 14, 95.5),
        '--bg-2': hslToHex(hsl.h, 14, 89),
        '--surface': '#FFFFFF',
        '--surface-2': hslToHex(hsl.h, 20, 98),
        '--surface-3': hslToHex(hsl.h, 16, 93.5)
    };
}

const THEME_PROPS = ['--accent', '--accent-2', '--accent-soft', '--accent-border', '--accent-rgb',
    '--accent-fill', '--accent-fill-2', '--accent-fg', '--ink', '--ink-2', '--ink-3',
    '--bg', '--bg-2', '--surface', '--surface-2', '--surface-3'];
function applyThemeColours() {
    const root = document.documentElement;
    const mode = currentTheme();
    if (themeKey() === 'default') {
        /* hand the palette back to the stylesheet, untouched */
        THEME_PROPS.forEach(p => root.style.removeProperty(p));
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', getComputedStyle(root).getPropertyValue('--ink').trim() || '#322D29');
        return;
    }
    const base = themeAccent();
    const tokens = Object.assign({}, accentTokens(base, mode), inkTokens(themeInk()), surfaceTokens(base, mode));
    Object.entries(tokens).forEach(([k, v]) => root.style.setProperty(k, v));
    /* the header's colour bar in the browser chrome follows the ink */
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', tokens['--ink']);
}

/* ── pictures ── */
function loadMedia() {
    try { return JSON.parse(lsGet(MEDIA_KEY) || '{}') || {} } catch (e) { return {} }
}
function saveMedia(media) {
    const text = JSON.stringify(media);
    if (text.length > MEDIA_LIMIT) { showToast('That picture is too large to store'); return false }
    const res = lsSet(MEDIA_KEY, text);
    if (!res.ok) {
        showToast(isQuotaError(res.err) ? 'No room left on this device for that picture' : 'That picture could not be saved');
        return false;
    }
    return true;
}
/* Shrink before storing. A phone photo is several megabytes; at the
   size it is actually shown, a fraction of that is plenty. */
function downscaleImage(file, maxSide, type, quality) {
    return new Promise((resolve, reject) => {
        if (!file || !/^image\//.test(file.type)) { reject(new Error('That file is not a picture')); return }
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('That file could not be read'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('That picture could not be opened'));
            img.onload = () => {
                const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
                const w = Math.max(1, Math.round(img.width * scale));
                const h = Math.max(1, Math.round(img.height * scale));
                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (type === 'image/jpeg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h) }
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL(type, quality));
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

function applyAppearance() {
    applyThemeColours();
    const media = loadMedia();
    const st = settings();

    /* the logo replaces the initial in the corner mark */
    const mark = document.getElementById('headerMark');
    if (mark) {
        if (media.logo) {
            mark.classList.add('has-logo');
            mark.innerHTML = '<img src="' + media.logo + '" alt="">';
        } else {
            mark.classList.remove('has-logo');
            mark.textContent = brandInitial(st.appName);
        }
    }
    const lockMark = document.getElementById('lockMark');
    if (lockMark) {
        if (media.logo) { lockMark.classList.add('has-logo'); lockMark.innerHTML = '<img src="' + media.logo + '" alt="">' }
        else { lockMark.classList.remove('has-logo'); lockMark.textContent = brandInitial(st.appName) }
    }

    /* the backdrop, kept faint so the figures in front stay the subject */
    const decor = document.getElementById('bgDecor');
    if (decor) {
        const mode = st.bgMode || 'default';
        if (mode === 'none') {
            decor.style.backgroundImage = 'none';
            decor.style.opacity = '0';
        } else if (mode === 'custom' && media.bg) {
            decor.style.backgroundImage = 'url("' + media.bg + '")';
            decor.style.opacity = String(bgOpacity() / 100);
        } else {
            decor.style.backgroundImage = 'url("' + themeArtUrl(currentTheme()) + '")';
            decor.style.opacity = String(bgOpacity() / 100);
        }
    }
}
function bgOpacity() {
    const v = parseInt(settings().bgOpacity);
    return isNaN(v) ? 100 : Math.max(0, Math.min(100, v));
}

/* ── the Appearance controls in Settings ── */
function renderThemePicker() {
    const wrap = document.getElementById('themeSwatches'); if (!wrap) return;
    const current = themeKey();
    wrap.innerHTML = THEME_ORDER.map(key => {
        const t = THEMES[key];
        const light = accentTokens(t.accent, 'light');
        const board = t.stock
            ? 'Background/' + (currentTheme() === 'dark' ? '2' : '1') + '.png'
            : 'Background/' + key + '-' + (currentTheme() === 'dark' ? 'dark' : 'light') + '.png';
        return `<button type="button" class="theme-swatch${current === key ? ' active' : ''}" data-theme-key="${key}"
            onclick="pickTheme('${key}')" aria-pressed="${current === key}" title="${t.name}">
            <span class="theme-swatch-art" style="background-color:${t.ink};background-image:url('${board}')">
                <span class="theme-swatch-dot" style="background:${light['--accent-fill']}"></span>
                <span class="theme-swatch-dot" style="background:${light['--accent-2']}"></span>
            </span>
            <span class="theme-swatch-name">${t.name}</span>
        </button>`;
    }).join('') +
        `<button type="button" class="theme-swatch${current === 'custom' ? ' active' : ''}" data-theme-key="custom"
            onclick="pickTheme('custom')" aria-pressed="${current === 'custom'}" title="Your own colour">
            <span class="theme-swatch-art custom-art"><span class="theme-swatch-dot"
                style="background:${vizEsc(settings().accent || THEMES.luxe.accent)}"></span></span>
            <span class="theme-swatch-name">Custom</span>
        </button>`;
    const row = document.getElementById('customColourRow');
    if (row) row.classList.toggle('show', current === 'custom');
    const input = document.getElementById('setAccent');
    if (input) input.value = settings().accent || THEMES.luxe.accent;
}
function pickTheme(key) {
    const st = settings();
    st.theme = key;
    if (key === 'custom' && !st.accent) st.accent = THEMES.luxe.accent;
    save(); applyAppearance(); renderThemePicker(); render();
}
function setCustomAccent(hex) {
    if (!hexToRgb(hex)) return;
    const st = settings();
    st.theme = 'custom'; st.accent = hex;
    save(); applyAppearance(); renderThemePicker(); render();
}

function renderAppearanceState() {
    const media = loadMedia();
    const st = settings();

    const logoPrev = document.getElementById('logoPreview');
    if (logoPrev) {
        logoPrev.innerHTML = media.logo
            ? `<img src="${media.logo}" alt="Your logo">`
            : `<span>${vizEsc(brandInitial(st.appName))}</span>`;
        logoPrev.classList.toggle('has-logo', !!media.logo);
    }
    const logoClear = document.getElementById('logoClearBtn');
    if (logoClear) logoClear.style.display = media.logo ? '' : 'none';

    const mode = st.bgMode || 'default';
    document.querySelectorAll('[data-bg-mode]').forEach(b => {
        const on = b.dataset.bgMode === mode;
        b.classList.toggle('active', on);
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    const bgPrev = document.getElementById('bgPreview');
    if (bgPrev) {
        bgPrev.style.backgroundImage = mode === 'none' ? 'none'
            : mode === 'custom' && media.bg ? `url("${media.bg}")`
                : `url("${themeArtUrl(currentTheme())}")`;
        bgPrev.style.opacity = mode === 'none' ? '0.15' : String(Math.max(0.08, bgOpacity() / 100));
    }
    const slider = document.getElementById('setBgOpacity');
    if (slider) {
        slider.value = bgOpacity();
        slider.disabled = mode === 'none';
    }
    setText('bgOpacityVal', bgOpacity() + '%');
    const bgClear = document.getElementById('bgClearBtn');
    if (bgClear) bgClear.style.display = media.bg ? '' : 'none';
}
function setBgMode(mode) {
    const st = settings();
    if (mode === 'custom' && !loadMedia().bg) {
        showToast('Choose a picture first');
        const picker = document.getElementById('bgFile'); if (picker) picker.click();
        return;
    }
    st.bgMode = mode;
    save(); applyAppearance(); renderAppearanceState();
}
function setBgOpacity(v) {
    settings().bgOpacity = Math.max(0, Math.min(100, parseInt(v) || 0));
    applyAppearance(); renderAppearanceState();
}
function commitBgOpacity() { save() }

async function handleLogoFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
        /* PNG so a cut-out logo keeps its transparent edges */
        const dataUrl = await downscaleImage(file, 256, 'image/png', 1);
        const media = loadMedia();
        media.logo = dataUrl;
        if (!saveMedia(media)) return;
        applyAppearance(); renderAppearanceState();
        showToast('Logo updated ✓');
    } catch (e) { showToast(e.message || 'That picture could not be used') }
}
function clearLogo() {
    const media = loadMedia();
    delete media.logo;
    saveMedia(media);
    applyAppearance(); renderAppearanceState();
    showToast('Logo removed');
}
async function handleBgFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
        /* a JPEG at screen size — a backdrop never needs more */
        const dataUrl = await downscaleImage(file, 1600, 'image/jpeg', 0.72);
        const media = loadMedia();
        const firstOne = !media.bg;
        media.bg = dataUrl;
        if (!saveMedia(media)) return;
        settings().bgMode = 'custom';
        /* a photo behind a page of figures wants to be faint — start it
           low and let the slider take it up if they want more */
        if (firstOne) settings().bgOpacity = 35;
        save(); applyAppearance(); renderAppearanceState();
        showToast('Background updated ✓');
    } catch (e) { showToast(e.message || 'That picture could not be used') }
}
function clearBg() {
    const media = loadMedia();
    delete media.bg;
    saveMedia(media);
    if ((settings().bgMode || 'default') === 'custom') settings().bgMode = 'default';
    save(); applyAppearance(); renderAppearanceState();
    showToast('Background picture removed');
}

/* Everything above is defined now, so the chosen palette, logo and
   backdrop can go on. This runs before the browser's first paint, so
   there is no flash of the default theme. */
applyAppearance();

/* ── putting the look back to how it started ──
   Everything from the title down to the background: the name, the
   colour theme, the logo and the backdrop. Deliberately nothing else —
   the records, categories, accounts, currency and PIN are left alone,
   and the message says so before anything happens. */
function resetCustomisation() {
    const st = settings();
    const media = loadMedia();
    const hasPictures = !!(media.logo || media.bg);
    if (!confirm('Put the name and look back to how they started?\n\n' +
        'This resets the title, subtitle, colour theme' +
        (hasPictures ? ', your logo and your background picture' : ' and the background') +
        '.\n\nYour records, categories, accounts and PIN are not touched.')) return;

    st.appName = DEFAULT_SETTINGS.appName;
    st.appTagline = DEFAULT_SETTINGS.appTagline;
    st.theme = DEFAULT_SETTINGS.theme;
    st.accent = DEFAULT_SETTINGS.accent;
    st.bgMode = DEFAULT_SETTINGS.bgMode;
    st.bgOpacity = DEFAULT_SETTINGS.bgOpacity;
    /* the pictures live under their own key, so they are cleared there */
    lsRemove(MEDIA_KEY);

    save();
    /* the two text boxes are open in front of the user, so they are put
       back too rather than keeping what was typed */
    const name = document.getElementById('setAppName');
    const tagline = document.getElementById('setAppTagline');
    if (name) name.value = st.appName;
    if (tagline) tagline.value = st.appTagline;

    applySettings(); applyAppearance(); syncAccountUI(); render();
    renderThemePicker(); renderAppearanceState();
    showToast('Name and look reset ✓');
}

/* ════════════════════════════════════════════════════════════════
   OFFLINE STATUS

   On a phone there is no console to look at, so "it did not open
   offline" is impossible to explain. This reads the real state of
   the service worker and its cache and says so in plain words,
   right inside Settings.
   ════════════════════════════════════════════════════════════════ */
async function readOfflineStatus() {
    const out = { supported: false, secure: window.isSecureContext, protocol: location.protocol, error: swError };
    if (!('serviceWorker' in navigator)) return out;
    out.supported = true;
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        out.registered = !!reg;
        if (reg) {
            out.state = reg.active ? 'active' : reg.installing ? 'installing' : reg.waiting ? 'waiting' : 'unknown';
            out.scope = reg.scope;
        }
        out.controlled = !!navigator.serviceWorker.controller;
        if (window.caches) {
            const names = await caches.keys();
            out.cacheNames = names;
            const mine = names.filter(n => n.indexOf('tracker-') === 0).pop();
            if (mine) {
                out.cacheName = mine;
                out.cached = (await (await caches.open(mine)).keys()).length;
            }
        }
    } catch (e) { out.error = out.error || String(e) }
    return out;
}
async function renderOfflineStatus() {
    const box = document.getElementById('offlineStatus'); if (!box) return;
    box.textContent = 'Checking…';
    const s = await readOfflineStatus();

    /* ready means: a worker is in charge AND the shell is in the cache */
    const ready = s.supported && s.registered && s.state === 'active' && s.controlled && s.cached > 0;
    let head, why;
    if (!s.supported) {
        head = 'Not available in this browser';
        why = 'This browser does not support offline pages. The tracker still works normally while you have a connection.';
    } else if (s.protocol === 'file:') {
        head = 'Not available when opened from a file';
        why = 'You have opened the tracker from a file on the device rather than from a web address. Offline only works from an http:// or https:// address — open your GitHub Pages link instead.';
    } else if (!s.secure) {
        head = 'Not available on this address';
        why = 'Offline needs a secure address. GitHub Pages is https, so it will work there.';
    } else if (s.error) {
        head = 'Could not be set up';
        why = 'The tracker tried to save itself for offline use and was refused: ' + vizEsc(s.error);
    } else if (!s.registered) {
        head = 'Not saved yet';
        why = 'Reload this page once while you have a connection, then check again.';
    } else if (!ready) {
        head = 'Almost ready';
        why = 'The offline copy is still being set up. Reload once more with a connection, then check again.';
    } else {
        head = 'Ready — this tracker opens without internet';
        why = s.cached + ' files are saved on this device. Turn off your data and reload to try it.';
    }

    /* An installed copy is the most reliable way to open with no signal,
       especially on iPhone where a plain browser tab often refuses. */
    let install = '';
    if (isInstalled()) {
        install = '<p class="settings-hint offline-installed">✓ Running as an installed app — the most reliable way to open it offline.</p>';
    } else if (deferredInstall) {
        install = '<div class="settings-btn-row" style="margin-top:10px">' +
            '<button type="button" class="storage-btn" onclick="installApp()">Add to home screen</button></div>' +
            '<p class="settings-hint">Installing it opens the tracker like an app, and makes opening it offline far more dependable.</p>';
    } else if (isIOS()) {
        install = '<p class="settings-hint"><strong>On iPhone and iPad</strong>, a plain Safari tab is unreliable with no signal. ' +
            'Tap <strong>Share</strong> → <strong>Add to Home Screen</strong>, then open the tracker from that icon instead.</p>';
    }

    box.innerHTML =
        `<p class="offline-state${ready ? ' ok' : ''}"><strong>${vizEsc(head)}</strong></p>` +
        `<p class="settings-hint">${why}</p>` + install +
        `<p class="settings-hint offline-detail">` +
        `Worker: ${s.registered ? vizEsc(s.state || 'yes') : 'none'} · ` +
        `In charge of this page: ${s.controlled ? 'yes' : 'no'} · ` +
        `Files saved: ${s.cached == null ? '0' : s.cached} · ` +
        `Installed: ${isInstalled() ? 'yes' : 'no'} · ` +
        `App ${APP_VERSION}` +
        (s.cacheName ? ' · ' + vizEsc(s.cacheName) : '') +
        `</p>`;
}
/* force a fresh check for the shipped files */
async function refreshOfflineCopy() {
    if (!('serviceWorker' in navigator)) { showToast('Not supported in this browser'); return }
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) {
            await navigator.serviceWorker.register('./sw.js');
            showToast('Saving for offline…');
        } else {
            await reg.update();
            showToast('Offline copy refreshed ✓');
        }
    } catch (e) { showToast('Could not save for offline') }
    setTimeout(renderOfflineStatus, 1200);
}

/* ════════════════════════════════════════════════════════════════
   INSTALLING TO THE HOME SCREEN

   Android fires beforeinstallprompt when the page qualifies; holding
   on to it lets the tracker offer the install itself rather than
   leaving people to find "Add to Home screen" in the browser menu.
   iOS never fires it, so there the Settings panel says how to do it
   by hand instead.
   ════════════════════════════════════════════════════════════════ */
let deferredInstall = null;
function isInstalled() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        navigator.standalone === true;
}
function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
window.addEventListener('beforeinstallprompt', ev => {
    /* stop the browser's own banner so the offer appears where the rest
       of the offline settings are */
    ev.preventDefault();
    deferredInstall = ev;
    renderOfflineStatus();
});
window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    renderOfflineStatus();
    showToast('Added to your home screen ✓');
});
async function installApp() {
    if (!deferredInstall) { showToast('Use your browser menu to add it'); return }
    deferredInstall.prompt();
    try { await deferredInstall.userChoice } catch (e) { }
    deferredInstall = null;
    renderOfflineStatus();
}

/* ════════════════════════════════════════════════════════════════
   FORCING AN UPDATE

   The offline copy is deliberately served cache-first, which is what
   makes the tracker open instantly with no signal — but it also means
   a device can keep running old code until it happens to notice a new
   version. This asks for the check on demand, takes the new worker
   straight away, and reloads onto it.
   ════════════════════════════════════════════════════════════════ */
async function forceUpdate() {
    if (!('serviceWorker' in navigator)) { location.reload(true); return }
    showToast('Checking for a newer version…');
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (!reg) { location.reload(); return }
        await reg.update();
        /* give the new worker a moment to reach "installed" */
        await new Promise(r => setTimeout(r, 1500));
        const waiting = reg.waiting;
        if (waiting) {
            /* controllerchange reloads the page once this takes over */
            waiting.postMessage('skip-waiting');
            setTimeout(() => location.reload(), 1200);
        } else {
            showToast('Already on the newest version');
            renderOfflineStatus();
        }
    } catch (e) {
        showToast('Could not check — reloading');
        setTimeout(() => location.reload(), 600);
    }
}

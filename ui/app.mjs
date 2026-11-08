import { createEqGraph } from './graph-editor.mjs';
import { presets, tuningProfile, headroom } from './tuning.mjs';
import { createProfileLibrary } from './profile-library.mjs';
import { responseDb } from './response.mjs';

const $ = selector => document.querySelector(selector);
const invoke = window.__TAURI__?.core?.invoke;
const isAndroid = /Android/i.test(navigator.userAgent);
const connectedPreview = !invoke && new URLSearchParams(location.search).get('preview') === 'connected';
document.documentElement.classList.toggle('android', isAndroid);
const startingProfile = tuningProfile(presets.flat, 'Flat');
const draftKey = 'cmf-eq-draft-v1';
const bassCondition = 'Bass starting point · Custom EQ, ANC High, bass slider minimum, spatial off.';
let name = startingProfile.name, skipped = [], pending = null, importVersion = 0;
let rows = startingProfile.filters.map(filter => ({...filter, enabled: true}));
while (rows.length < 8) rows.push({id:rows.length+1,kind:'PK',frequency:1000,gain:0,q:1,enabled:false});
let toneValues = {...presets.flat}, writeReview = null, notificationTimer;
const undoDrafts = [], redoDrafts = [];
let selectedBand = 0;
let connection = { connected: false }, connectionBusy = false, pollTimer;
let adoptedDeviceEq = false;
if (connectedPreview) {
  connection = {
    connected: true,
    device: { name: 'CMF Headphone Pro', address: 'Preview device' },
    firmware: 'Preview',
    battery: { percent: 85, charging: false },
    anc_mode: 1,
    spatial_mode: 0,
    eq: structuredClone(startingProfile),
    warnings: [],
  };
}
let ancExpanded = false;
let profileLibrary = null;
let eqGraph = null;
const deviceKey = () => connection.connected ? `${connection.device.address}|${connection.firmware}` : null;
const cloneProfile = profile => JSON.parse(JSON.stringify(profile));
let pendingCondition = 'Imported · match ANC to the profile’s measurement condition.';

function renderConnection() {
  const connected = connection.connected;
  $('#device-name').textContent = connection.device?.name || 'CMF Headphone Pro';
  $('#device-name').title = connection.device?.name || 'CMF Headphone Pro';
  $('#connection-state').textContent = connectionBusy ? (connected ? 'Updating settings…' : 'Connecting…') : connected ? 'Connected' : 'Not connected';
  if (connectedPreview) $('#connection-state').textContent = 'Connected preview';
  $('.companion').classList.toggle('connected', connected);
  $('#connection-screen').hidden = connected;
  $('.tabs').hidden = !connected;
  $('#connect-headphones').hidden = !connected;
  $('#connection-title').textContent = connectionBusy ? 'Connecting…' : 'Device Not Connected';
  const battery = connection.battery;
  $('#battery-level').textContent = battery ? `${battery.percent}%${battery.charging ? ' ⚡' : ''}` : '—';
  $('#battery').setAttribute('aria-label', battery ? `Battery ${battery.percent} percent${battery.charging ? ', charging' : ''}` : 'Battery unavailable');
  $('#connection-info').textContent = `Pair CMF Headphone Pro in ${isAndroid ? 'Android' : 'Windows'} Bluetooth settings, then connect.`;
  $('#connection-info').title = connected ? `Protocol ${connection.protocol_version} · ${connection.device.address} · Firmware ${connection.firmware}` : '';
  $('#scan-devices').disabled = !invoke || connected || connectionBusy;
  $('#scan-devices').textContent = connectionBusy ? 'Connecting…' : 'Connect headphones';
  $('#connect-headphones').disabled = !invoke || connectionBusy || !connected;
  $('#connect-headphones').textContent = connectionBusy ? 'Please wait…' : 'Disconnect';
  const warnings = connected && connection.warnings?.length > 0;
  $('.connection-feedback').hidden = !warnings;
  $('#connection-help').textContent = warnings ? `${connection.warnings.length} setting readback(s) unavailable.` : '';
  if (!warnings) {
    $('#status-detail').hidden = true;
    $('#connection-details').setAttribute('aria-expanded', 'false');
  }
  $('#connection-details').hidden = !warnings;
  const mode = connection.anc_mode;
  const ancNames = { 1: 'High', 2: 'Medium', 3: 'Low', 4: 'Adaptive', 5: 'Off', 7: 'Transparency' };
  const ancActive = connected && [1,2,3,4].includes(mode);
  const ancAvailable = Boolean(invoke && connected && ancNames[mode] && !connectionBusy);
  if (!connected) ancExpanded = false;
  for (const button of document.querySelectorAll('[data-noise]')) {
    const selected = connected && (button.dataset.noise === 'off' ? mode === 5 : button.dataset.noise === 'transparency' ? mode === 7 : [1,2,3,4].includes(mode));
    button.setAttribute('aria-pressed', String(selected));
    button.disabled = !ancAvailable;
  }
  $('#anc-levels').hidden = !(ancExpanded || ancActive);
  $('[data-noise="anc"]').setAttribute('aria-expanded', String(!$('#anc-levels').hidden));
  for (const button of document.querySelectorAll('[data-anc]')) {
    button.disabled = !ancAvailable;
    button.setAttribute('aria-pressed', String(ancActive && Number(button.dataset.anc) === mode));
  }
  const spatialAvailable = Boolean(invoke && connected && !connectionBusy && connection.spatial_mode !== null && connection.spatial_mode !== undefined && connection.firmware);
  for (const button of document.querySelectorAll('[data-spatial]')) {
    button.setAttribute('aria-pressed', String(connected && Number(button.dataset.spatial) === connection.spatial_mode));
    button.disabled = !spatialAvailable;
    button.title = 'Set spatial mode and check headphone readback.';
  }
  renderEqState();
  $('.spatial-help').textContent = connected ? 'Select a mode to apply it; readback is checked.' : 'Changes are checked on the headphones.';
  renderStoredEqPreview();
}

function renderStoredEqPreview() {
  const eq = connection.eq;
  const values = eq ? Array.from({ length: 81 }, (_, i) => responseDb(eq.filters, eq.preamp, 20 * 1000 ** (i / 80))) : [];
  const available = connection.connected && values.length > 0 && values.every(Number.isFinite);
  $('#stored-eq-preview').hidden = !available;
  if (!available) return;
  const scale = Math.max(12, ...values.map(Math.abs));
  const path = values.map((value, i) => `${i ? 'L' : 'M'}${i * 4},${(20 - value / scale * 18).toFixed(2)}`).join(' ');
  $('#stored-eq-curve').setAttribute('d', path);
  $('#stored-band-count').textContent = `${eq.filters.length} bands`;
  $('#stored-eq-graph').setAttribute('aria-label', `Calculated stored EQ response, 20 Hz to 20 kHz, range plus or minus ${scale.toFixed(1)} dB. Not a measured headphone response.`);
}

async function setAnc(mode) {
  if (!invoke || connectionBusy || !connection.connected) return;
  clearTimeout(pollTimer);
  connectionBusy = true;
  renderConnection();
  try {
    connection = await invoke('set_anc', { mode });
    ancExpanded = [1,2,3,4].includes(connection.anc_mode);
    if (connection.warnings?.length) message(connection.warnings.join(' '), true);
  } catch (error) {
    try { connection = await invoke('headphone_status'); }
    catch { connection = { connected: false }; }
    ancExpanded = false;
    message(String(error.message ?? error), true);
  } finally {
    connectionBusy = false;
    renderConnection();
    schedulePoll();
  }
}

for (const button of document.querySelectorAll('[data-noise]')) {
  button.onclick = () => {
    if (button.dataset.noise === 'anc') {
      ancExpanded = true;
      renderConnection();
      if (![1,2,3,4].includes(connection.anc_mode)) {
        if ([1,2,3,4].includes(connection.last_anc_mode)) setAnc(connection.last_anc_mode);
        else message('Choose Low, Medium, High or Adaptive to enable ANC.');
      }
    } else {
      ancExpanded = false;
      setAnc(button.dataset.noise === 'off' ? 5 : 7);
    }
  };
}
for (const button of document.querySelectorAll('[data-anc]')) {
  button.onclick = () => setAnc(Number(button.dataset.anc));
}

function connectionMessage(prefix) {
  message(`${prefix}${connection.warnings?.length ? ` ${connection.warnings.join(' ')}` : ''}`);
}

function schedulePoll() {
  clearTimeout(pollTimer);
  if (connection.connected && !connectionBusy && !document.hidden && !$('#eq-confirm').open) {
    // Battery-only ping; full settings are read once at connect time.
    pollTimer = setTimeout(() => pollBattery(), 300000);
  }
}

async function pollBattery() {
  if (!invoke || connectionBusy || !connection.connected) return;
  clearTimeout(pollTimer);
  connectionBusy = true;
  renderConnection();
  try {
    connection = await invoke('refresh_battery');
  } catch (error) {
    // Recover authoritative backend state instead of retaining a stale green header.
    try { connection = await invoke('headphone_status'); }
    catch { connection = { connected: false }; }
    message(String(error.message ?? error), true);
  } finally {
    connectionBusy = false;
    renderConnection();
    schedulePoll();
  }
}

async function scanDevices() {
  if (!invoke || connectionBusy || connection.connected) return;
  connectionBusy = true;
  renderConnection();
  try {
    const devices = await invoke('list_paired_devices');
    // Bluetooth reports the singular product name; also accept the older UI spelling.
    const device = devices.find(device => /^cmf headphones? pro$/i.test(device.name.trim().replace(/\s+/g, ' ')));
    if (!device) {
      message(`CMF Headphone Pro not found. Pair them in ${isAndroid ? 'Android' : 'Windows'} Bluetooth settings, then Connect headphones.`);
      return;
    }
    message(`${device.name} found. Connecting and reading settings…`);
    connection = await invoke('connect_headphones', { address: device.address });
    const adopted = adoptDeviceEq();
    connectionMessage(adopted
      ? `Connected to ${connection.device.name}. Firmware ${connection.firmware}. EQ read from the headphones is in the editor.`
      : `Connected to ${connection.device.name}. Firmware ${connection.firmware}. Your editor draft is unchanged.`);
  } catch (error) {
    try { connection = await invoke('headphone_status'); }
    catch { connection = { connected: false }; }
    message(String(error.message ?? error), true);
  } finally {
    connectionBusy = false;
    renderConnection();
    schedulePoll();
  }
}

$('#scan-devices').onclick = scanDevices;
$('#connection-details').onclick = () => {
  $('#status-detail').textContent = connection.warnings.join('\n\n');
  $('#status-detail').hidden = !$('#status-detail').hidden;
  $('#connection-details').setAttribute('aria-expanded', String(!$('#status-detail').hidden));
};
$('#connect-headphones').onclick = async () => {
  if (!invoke || connectionBusy || !connection.connected) return;
  clearTimeout(pollTimer);
  connectionBusy = true;
  renderConnection();
  message('Closing the headphone control connection…');
  try {
    connection = await invoke('disconnect_headphones');
    connectionMessage('Disconnected. Your draft and headphone settings are unchanged.');
  } catch (error) {
    try { connection = await invoke('headphone_status'); }
    catch { connection = { connected: false }; }
    message(String(error.message ?? error), true);
  } finally {
    connectionBusy = false;
    renderConnection();
    schedulePoll();
  }
};

document.addEventListener('visibilitychange', schedulePoll);
document.addEventListener('keydown', () => {
  $('#eq').classList.add('keyboard-input');
  $('#profiles').classList.add('keyboard-input');
  $('#settings').classList.add('keyboard-input');
}, true);
$('#profiles').addEventListener('pointerdown', () => $('#profiles').classList.remove('keyboard-input'), true);
$('#settings').addEventListener('pointerdown', () => $('#settings').classList.remove('keyboard-input'), true);
document.addEventListener('pointerdown', () => $('#eq').classList.remove('keyboard-input'), true);

function setEqMode(mode) {
  eqGraph?.cancel();
  closeBandEditor(false);
  $('#eq').dataset.mode = mode;
  $('#eq-presets').hidden = mode !== 'presets';
  $('#eq-custom').hidden = mode !== 'custom';
  $('#band-count').hidden = mode !== 'custom';
  $('#response').tabIndex = mode === 'custom' ? 0 : -1;
  $('#response').setAttribute('aria-label', mode === 'custom'
    ? 'Editable EQ response. Drag a numbered point to change frequency and gain. Use the band controls for Q.'
    : 'Read-only preset EQ response. Switch to Custom to edit the graph.');
  for (const button of document.querySelectorAll('[data-eq-mode]')) {
    button.setAttribute('aria-pressed', String(button.dataset.eqMode === mode));
  }
  if (eqGraph) {
    try { eqGraph.resize(); }
    catch { eqGraph.clear(); }
  }
}
for (const button of document.querySelectorAll('[data-eq-mode]')) {
  button.onclick = () => setEqMode(button.dataset.eqMode);
}

const tabs = [...document.querySelectorAll('[role="tab"]')];
function showTab(id, focus = false) {
  closeBandEditor(false);
  for (const tab of tabs) {
    const active = tab.getAttribute('aria-controls') === id;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    if (active && focus) tab.focus();
  }
  $('#status-detail').hidden = true;
  $('#connection-details').setAttribute('aria-expanded', 'false');
  $('#notification').hidden = true;
}
for (const [index, tab] of tabs.entries()) {
  tab.onclick = () => showTab(tab.getAttribute('aria-controls'));
  tab.onkeydown = event => {
    let target;
    if (event.key === 'ArrowRight') target = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') target = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') target = 0;
    if (event.key === 'End') target = tabs.length - 1;
    if (target !== undefined) {
      event.preventDefault();
      showTab(tabs[target].getAttribute('aria-controls'), true);
    }
  };
}

const appWindow = isAndroid ? null : window.__TAURI__?.window?.getCurrentWindow();
for (const [id, action] of [['minimize', 'minimize'], ['close', 'close']]) {
  $(`#${id}`).disabled = !appWindow;
  $(`#${id}`).onclick = async () => {
    try { await appWindow[action](); }
    catch (error) { message(String(error.message ?? error), true); }
  };
}
$('#pin').disabled = !appWindow;
$('#settings-pin').disabled = !appWindow;
$('#settings-pin').title = appWindow ? 'Keep the companion above other windows' : 'Available in the desktop app';
$('#settings-pin').onclick = () => $('#pin').click();
$('#pin').onclick = async () => {
  $('#pin').disabled = true;
  $('#settings-pin').disabled = true;
  try {
    const pinned = !(await appWindow.isAlwaysOnTop());
    await appWindow.setAlwaysOnTop(pinned);
    $('#pin').setAttribute('aria-pressed', String(pinned));
    $('#settings-pin').setAttribute('aria-pressed', String(pinned));
    $('#settings-pin').textContent = pinned ? 'On' : 'Off';
    $('#pin').title = pinned ? 'Unpin window' : 'Keep on top';
    $('#pin').setAttribute('aria-label', $('#pin').title);
  } catch (error) { message(String(error.message ?? error), true); }
  finally { $('#pin').disabled = false; $('#settings-pin').disabled = false; }
};
$('#choose-profile').onclick = async () => {
  if (!isAndroid || !invoke) { $('#profile-file').click(); return; }
  const version = ++importVersion;
  pending = null; $('#import-preview').hidden = true;
  try {
    const profile = await invoke('import_profile_file');
    if (!profile || version !== importVersion) return;
    pending = profile; pendingCondition = 'Imported · match ANC to the profile’s measurement condition.';
    $('#preview-label').textContent = 'IMPORT PREVIEW'; $('#import-name').textContent = profile.name;
    $('#import-summary').textContent = `${profile.filters.length} bands · ${profile.preamp} dB preamp`;
    $('#import-preview').hidden = false;
  } catch (error) { if (version === importVersion) message(String(error.message ?? error), true); }
};
$('#dismiss-notification').onclick = () => { $('#notification').hidden = true; };
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeBandEditor();
    $('#status-detail').hidden = true;
    $('#connection-details').setAttribute('aria-expanded', 'false');
    $('#notification').hidden = true;
  }
});

function message(text, error = false) {
  clearTimeout(notificationTimer);
  $('#message').textContent = text;
  $('#message').title = text;
  $('#notification').classList.toggle('is-error', error);
  $('#notification').hidden = false;
  if (!error) notificationTimer = setTimeout(() => { $('#notification').hidden = true; }, 5000);
}

function draft() {
  if (!$('#preamp').checkValidity()) throw Error('Enter a finite preamp value no higher than +10 dB.');
  for (const [index, filter] of rows.entries()) {
    if (filter.enabled && !validBand(filter)) {
      throw Error(`Check band ${index + 1}: use 20–20,000 Hz, a finite gain, and Q greater than zero.`);
    }
  }
  const filters = rows.filter(row => row.enabled).map(({enabled,...filter}) => filter);
  if (!filters.length) throw Error('Enable at least one filter.');
  const disabled = skipped.filter(id => !filters.some(filter => filter.id === id));
  return {name, preamp: Number($('#preamp').value), filters, disabled_filters: disabled};
}

function validBand(filter) {
  return [filter.frequency, filter.gain, filter.q].every(Number.isFinite)
    && filter.frequency >= 20 && filter.frequency <= 20000 && filter.q > 0;
}

function closeBandEditor(restoreFocus = true) {
  const wasOpen = !$('#band-editor').hidden;
  $('#band-editor').hidden = true;
  $('#tone-panel').hidden = false;
  for (const button of $('#bands').children) {
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-pressed', 'false');
  }
  if (wasOpen && restoreFocus) $('#bands').children[selectedBand]?.focus();
}

function openBandEditor(index) {
  selectGraphBand(index);
  $('#band-editor').hidden = false;
  $('#tone-panel').hidden = true;
  update();
  $('#band-enabled').focus();
}

function selectGraphBand(index) {
  selectedBand = index;
  const filter = rows[index];
  $('#band-title').textContent = `Band ${String(index + 1).padStart(2, '0')}`;
  $('#band-enabled').checked = filter.enabled;
  $('#band-kind').value = filter.kind;
  for (const field of ['frequency', 'gain', 'q']) {
    const input = $(`#band-${field}`);
    input.value = Number.isFinite(filter[field]) ? filter[field] : '';
    input.setCustomValidity(field === 'q' && filter.q <= 0 ? 'Q must be greater than zero.' : '');
  }
}

function renderBands() {
  $('#bands').replaceChildren();
  rows.forEach((_, index) => {
    const button = document.createElement('button');
    button.className = 'band-button';
    button.setAttribute('aria-controls', 'band-editor');
    button.innerHTML = '<strong></strong><span></span>';
    button.onclick = () => openBandEditor(index);
    button.onkeydown = event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % rows.length;
      if (event.key === 'ArrowLeft') next = (index + rows.length - 1) % rows.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = rows.length - 1;
      if (next !== undefined) {
        event.preventDefault();
        openBandEditor(next);
        $('#bands').children[next].focus();
      }
    };
    $('#bands').append(button);
  });
}

function update() {
  for (const [index, button] of [...$('#bands').children].entries()) {
    const filter = rows[index];
    const frequency = Number.isFinite(filter.frequency) ? String(Number((filter.frequency >= 1000 ? filter.frequency / 1000 : filter.frequency).toFixed(1))) + (filter.frequency >= 1000 ? 'k' : '') : '?';
    const invalid = filter.enabled && !validBand(filter);
    const selected = index === selectedBand && (!$('#band-editor').hidden || eqGraph?.dragging);
    button.querySelector('strong').textContent = String(index + 1).padStart(2, '0');
    button.querySelector('span').textContent = filter.enabled ? `${frequency} Hz` : 'Off';
    button.classList.toggle('off', !filter.enabled);
    button.classList.toggle('invalid', invalid);
    button.setAttribute('aria-pressed', String(selected));
    button.setAttribute('aria-expanded', String(index === selectedBand && !$('#band-editor').hidden));
    button.setAttribute('aria-label', `Edit band ${index + 1}, ${filter.enabled ? 'enabled' : 'disabled'}, ${filter.frequency} Hz, ${filter.gain} dB, Q ${filter.q}${invalid ? ', invalid settings' : ''}`);
    button.title = `Band ${index + 1} · ${filter.frequency} Hz · ${filter.gain} dB · Q ${filter.q}${invalid ? ' · Check settings' : ''}`;
  }
  $('#band-enabled-label').textContent = rows[selectedBand].enabled ? 'Enabled' : 'Disabled';
  $('#profile-name').textContent=name;
  $('#band-count').textContent=`${rows.filter(row=>row.enabled).length} / 8 bands`;
  try {
    const current=draft();
    if(!Number.isFinite(current.preamp)||current.filters.some(f=>![f.frequency,f.gain,f.q].every(Number.isFinite)||f.q<=0))throw Error('Enter finite EQ values and a positive Q.');
    eqGraph?.draw(current);
  } catch(error){eqGraph?.clear();}
  renderEqState();
  renderDraftHistory();
}

function useProfile(profile, condition = 'Imported draft · match ANC to the profile’s measurement condition.', tone = null) {
  eqGraph?.cancel();
  closeBandEditor(false);
  toneValues = tone ? {...tone} : null;
  name=profile.name;skipped=profile.disabled_filters;rows=profile.filters.map(filter=>({...filter,enabled:true}));
  let id=Math.max(0,...rows.map(row=>row.id));
  while(rows.length<8)rows.push({id:++id,kind:'PK',frequency:1000,gain:0,q:1,enabled:false});
  selectedBand=0;
  $('#preamp').value=profile.preamp;renderBands();update();
  $('#condition').textContent=condition;
  syncToneControls();
  setEqMode(tone ? 'presets' : 'custom');
}

// The first connection of a session opens the device's stored EQ in the editor.
// Later reconnects keep the user's draft, which may already hold unsaved changes.
function adoptDeviceEq() {
  if (adoptedDeviceEq || !connection.connected || !connection.eq) return false;
  adoptedDeviceEq = true;
  const profile = cloneProfile(connection.eq);
  // The device carries no profile name; keep the editor title short enough to fit.
  profile.name = 'Headphone EQ';
  changeDraft(() => useProfile(profile, 'Device EQ · read from the headphones when the app started.', null));
  return true;
}

$('#preamp').addEventListener('focus', beginDraftGesture);
$('#preamp').addEventListener('blur', endDraftGesture);
$('#preamp').oninput = () => { beginDraftGesture(); update(); };
for (const [id, delta] of [['preamp-down', -0.5], ['preamp-up', 0.5]]) {
  $(`#${id}`).onclick = () => {
    const current = $('#preamp').valueAsNumber;
    if (!Number.isFinite(current)) return;
    changeDraft(() => {
      $('#preamp').value = Math.min(10, Number((current + delta).toFixed(6)));
      update();
    });
  };
}
$('#close-band').onclick = () => { closeBandEditor(); update(); };
for (const id of ['band-enabled', 'band-kind', 'band-frequency', 'band-gain', 'band-q']) {
  $(`#${id}`).addEventListener('focus', beginDraftGesture);
  $(`#${id}`).addEventListener('blur', endDraftGesture);
}
$('#band-enabled').onchange = event => { beginDraftGesture(); rows[selectedBand].enabled = event.target.checked; update(); };
$('#band-kind').onchange = event => { beginDraftGesture(); rows[selectedBand].kind = event.target.value; update(); };
for (const field of ['frequency', 'gain', 'q']) {
  $(`#band-${field}`).oninput = event => {
    const input = event.target;
    beginDraftGesture();
    rows[selectedBand][field] = input.value === '' ? NaN : Number(input.value);
    input.setCustomValidity(field === 'q' && rows[selectedBand].q <= 0 ? 'Q must be greater than zero.' : '');
    update();
  };
}
function syncToneControls() {
  const values = toneValues ?? presets.flat;
  for (const key of ['deep', 'punch', 'clarity']) {
    $(`#tone-${key}`).value = values[key];
    $(`#tone-${key}-value`).value = `${values[key]}%`;
  }
  for (const button of document.querySelectorAll('[data-preset]')) {
    button.setAttribute('aria-pressed', String(Boolean(toneValues && name === presets[button.dataset.preset].name)));
  }
}

function renderEqState() {
  let valid = false;
  try {
    const profile = draft();
    valid = true;
    try {
      const estimate = headroom(profile);
      $('#headroom-status').textContent = `Estimated peak ${estimate.outputPeak > 0 ? '+' : ''}${estimate.outputPeak.toFixed(1)} dB · draft${estimate.outputPeak > 0 ? ' · clipping possible' : ''}`;
      $('#headroom-status').classList.toggle('invalid-draft', estimate.outputPeak > 0);
      $('#headroom-recommended').textContent = `Auto headroom sets the preamp to ${estimate.recommended} dB.`;
      $('#auto-headroom').disabled = false;
    } catch {
      $('#headroom-status').textContent = 'Peak estimate unavailable · manual EQ';
      $('#headroom-recommended').textContent = '';
      $('#headroom-status').classList.remove('invalid-draft');
      $('#auto-headroom').disabled = true;
    }
    $('#save-draft').disabled = !invoke || Boolean(profileLibrary?.busy);
  } catch (error) {
    $('#headroom-status').textContent = error.message;
    $('#headroom-recommended').textContent = '';
    $('#headroom-status').classList.add('invalid-draft');
    $('#auto-headroom').disabled = true;
    $('#save-draft').disabled = true;
  }
  const canWrite = Boolean(invoke && connection.connected && !connectionBusy && connection.firmware);
  $('#apply-eq').disabled = !canWrite || !valid || !connection.eq;
  $('#apply-eq').title = !invoke ? 'Open the desktop app to apply EQ.' : !connection.connected ? 'Connect your headphones first.' : !valid ? 'Check the preamp and band values.' : 'Review the selected device and EQ before applying.';
}

function captureDraft() {
  return { profile: draft(), condition: $('#condition').textContent, tone: toneValues ? {...toneValues} : null, mode: $('#eq').dataset.mode };
}

// Keep disabled rows and invalid in-progress fields so undo/redo restores the whole editor.
function captureDraftState() {
  return { name, rows: rows.map(row => ({...row})), skipped: [...skipped], preamp: $('#preamp').value,
    condition: $('#condition').textContent, tone: toneValues ? {...toneValues} : null,
    mode: $('#eq').dataset.mode, selectedBand };
}
function draftChanged(previous) {
  const content = ({mode, selectedBand, ...state}) => JSON.stringify(state);
  return content(previous) !== content(captureDraftState());
}
function restoreDraftState(state) {
  eqGraph?.cancel();
  closeBandEditor(false);
  name = state.name; rows = state.rows.map(row => ({...row})); skipped = [...state.skipped];
  toneValues = state.tone ? {...state.tone} : null; selectedBand = state.selectedBand;
  $('#preamp').value = state.preamp; $('#condition').textContent = state.condition;
  renderBands(); selectGraphBand(selectedBand); syncToneControls(); setEqMode(state.mode); update();
}
// One undo step per gesture: sliders, band fields and graph drags capture once at the start.
let draftGesture = null;
function renderDraftHistory() {
  const changing = draftGesture && draftChanged(draftGesture);
  $('#undo-draft').disabled = !undoDrafts.length && !changing;
  $('#redo-draft').disabled = !redoDrafts.length || Boolean(changing);
  const preamp = $('#preamp').valueAsNumber;
  $('#preamp-down').disabled = !Number.isFinite(preamp);
  $('#preamp-up').disabled = !Number.isFinite(preamp) || preamp >= 10;
}
function recordDraftChange(previous) {
  if (draftChanged(previous)) { undoDrafts.push(previous); redoDrafts.length = 0; }
  renderDraftHistory();
}
function beginDraftGesture() { draftGesture ??= captureDraftState(); }
function endDraftGesture() {
  const previous = draftGesture; draftGesture = null;
  if (previous) recordDraftChange(previous);
}
function changeDraft(change) {
  endDraftGesture();
  const previous = captureDraftState();
  change();
  recordDraftChange(previous);
}
window.addEventListener('blur', () => { if (!eqGraph?.dragging) endDraftGesture(); });

// Custom mode: tone sliders stay relative to the current balance and bake the
// change into the enabled bands, so the graph always shows the true draft.
function applyTonePull(values) {
  beginDraftGesture();
  try {
    const from = tuningProfile(toneValues ?? presets.flat, 'Previous balance');
    const to = tuningProfile(values, 'New balance');
    for (const row of rows) {
      if (!row.enabled) continue;
      const delta = responseDb(to.filters, 0, row.frequency) - responseDb(from.filters, 0, row.frequency);
      if (!Number.isFinite(delta)) continue;
      row.gain = Math.round(Math.max(-24, Math.min(24, row.gain + delta)) * 10) / 10;
    }
    toneValues = values;
    syncToneControls();
    update();
  } catch (error) { message(error.message, true); }
}

for (const button of document.querySelectorAll('[data-preset]')) {
  button.onclick = () => {
    if (!$('#preamp').checkValidity()) { message('Enter a finite preamp value no higher than +10 dB.', true); return; }
    const preamp = Number($('#preamp').value);
    const preset = presets[button.dataset.preset];
    changeDraft(() => useProfile(tuningProfile(preset, preset.name, preamp), preset === presets.flat ? 'Flat bands · your preamp stays unchanged.' : bassCondition, preset));
  };
}
for (const [id, source, target] of [['undo-draft', undoDrafts, redoDrafts], ['redo-draft', redoDrafts, undoDrafts]]) {
  $(`#${id}`).onclick = () => {
    eqGraph?.cancel(); endDraftGesture();
    if (!source.length) return;
    target.push(captureDraftState());
    restoreDraftState(source.pop());
  };
}
for (const key of ['deep', 'punch', 'clarity']) {
  const slider = $(`#tone-${key}`);
  slider.addEventListener('pointerdown', beginDraftGesture);
  slider.addEventListener('keydown', beginDraftGesture);
  slider.addEventListener('change', endDraftGesture);
  slider.addEventListener('pointerup', endDraftGesture);
  slider.addEventListener('pointercancel', endDraftGesture);
  slider.addEventListener('keyup', endDraftGesture);
  slider.addEventListener('blur', endDraftGesture);
  slider.oninput = event => {
    beginDraftGesture();
    const values = {...(toneValues ?? presets.flat), [key]: Number(event.target.value)};
    if ($('#eq').dataset.mode === 'custom') {
      applyTonePull(values);
      return;
    }
    try {
      if (!$('#preamp').checkValidity()) throw Error('Enter a finite preamp value no higher than +10 dB.');
      useProfile(tuningProfile(values, undefined, Number($('#preamp').value)), bassCondition, values);
    }
    catch (error) { message(error.message, true); }
  };
}
$('#auto-headroom').onclick = () => { $('#headroom-dialog').showModal(); };
$('#cancel-headroom').onclick = () => { if (!connectionBusy) $('#headroom-dialog').close(); };
$('#confirm-headroom').onclick = () => {
  try { const preamp = headroom(draft()).recommended; changeDraft(() => { $('#preamp').value = preamp; update(); }); $('#headroom-dialog').close(); }
  catch (error) { message(error.message, true); }
};
$('#save-draft').onclick = () => profileLibrary.openSave();

function initializeDraft() {
  useProfile(startingProfile, 'Flat custom EQ · 0 dB preamp; no additional correction.', presets.flat);
  try {
    const text = localStorage.getItem(draftKey);
    if (!text) return;
    if (text.length > 256 * 1024) throw Error('Saved draft is too large.');
    const saved = JSON.parse(text), profile = saved.profile;
    const finite = value => typeof value === 'number' && Number.isFinite(Math.fround(value));
    const ids = new Set();
    if (saved.version !== 1 || typeof profile?.name !== 'string' || !finite(profile.preamp)
      || !Array.isArray(profile.filters) || profile.filters.length < 1 || profile.filters.length > 8
      || !Array.isArray(profile.disabled_filters)) throw Error('Saved draft format is invalid.');
    for (const filter of profile.filters) {
      if (!Number.isSafeInteger(filter.id) || filter.id <= 0 || ids.has(filter.id)
        || !['PK','LS','HS'].includes(filter.kind) || !validBand(filter)
        || ![filter.frequency, filter.gain, filter.q].every(finite)) throw Error('Saved band settings are invalid.');
      ids.add(filter.id);
    }
    for (const id of profile.disabled_filters) {
      if (!Number.isSafeInteger(id) || id <= 0 || ids.has(id)) throw Error('Saved filter IDs are invalid.');
      ids.add(id);
    }
    let tone = null;
    if (saved.tone) {
      try {
        const rebuilt = tuningProfile(saved.tone, undefined, profile.preamp);
        const same = (left, right) => Math.fround(left) === Math.fround(right);
        if (same(profile.preamp, rebuilt.preamp) && profile.filters.length === rebuilt.filters.length
          && profile.filters.every((filter, index) => filter.kind === rebuilt.filters[index].kind
            && ['frequency','gain','q'].every(key => same(filter[key], rebuilt.filters[index][key])))) tone = saved.tone;
      } catch { /* Hand-edited profiles reopen with the advanced controls. */ }
    }
    useProfile(profile, typeof saved.condition === 'string' ? saved.condition : 'Saved editor draft.', tone);
    showTab('eq');
  } catch (error) { message(`Saved draft could not be loaded. Flat draft opened instead. ${error.message}`, true); }
}

function appendProfileRows(profile, label = '') {
  const body = $('#eq-confirm-bands');
  if (label) {
    const tr = document.createElement('tr'), cell = document.createElement('th');
    cell.colSpan = 5;
    cell.textContent = `${label} · ${profile.preamp} dB preamp`;
    tr.append(cell); body.append(tr);
  }
  for (const [index, filter] of profile.filters.entries()) {
    const tr = document.createElement('tr');
    for (const value of [index + 1, filter.kind, filter.frequency, filter.gain, filter.q]) {
      const td = document.createElement('td');
      td.textContent = typeof value === 'number' ? String(Number(value.toPrecision(6))) : value;
      tr.append(td);
    }
    body.append(tr);
  }
}

async function reviewEq(action, value = null) {
  if (!invoke || connectionBusy || !connection.connected) return;
  clearTimeout(pollTimer);
  connectionBusy = true;
  renderConnection();
  try {
    const target = { address: connection.device.address, firmware: connection.firmware };
    let profile = action === 'apply' ? await invoke('validate_profile', {profile: draft()}) : null;
    writeReview = {action, profile, value, key: deviceKey(), ...target};
    $('#eq-confirm-title').textContent = 'Review your EQ';
    $('#eq-confirm-target').textContent = `${connection.device.name} · ${target.address} · firmware ${target.firmware}`;
    $('#eq-confirm-summary').textContent = profile ? `${profile.name} · ${profile.filters.length} bands · ${profile.preamp} dB preamp.` : connection.eq_write_note || 'Stored filter values. Audible preset activation is not detected.';
    $('#eq-confirm-bands').replaceChildren();
    if (profile) appendProfileRows(profile);
    else {
      if (connection.requested_eq) appendProfileRows(connection.requested_eq, 'Last requested');
      if (connection.eq) appendProfileRows(connection.eq, 'Read from headphones');
    }
    $('#confirm-eq').textContent = 'Apply and verify';
    $('#cancel-eq').textContent = 'Cancel';
    $('#eq-confirm-result').textContent = '';
    $('#eq-confirm').showModal();
  } catch (error) { message(String(error.message ?? error), true); }
  finally { connectionBusy = false; renderConnection(); schedulePoll(); }
}

$('#apply-eq').onclick = () => reviewEq('apply');
for (const button of document.querySelectorAll('[data-spatial]')) button.onclick = () => {
  const mode = Number(button.dataset.spatial);
  if (!invoke || connectionBusy || mode === connection.spatial_mode) return;
  commitDeviceChange({action:'spatial',value:mode,address:connection.device.address,firmware:connection.firmware});
};
$('#cancel-eq').onclick = () => { if (!connectionBusy) $('#eq-confirm').close(); };
$('#eq-confirm').addEventListener('cancel', event => { if (connectionBusy) event.preventDefault(); });
$('#eq-confirm').addEventListener('close', () => { writeReview = null; schedulePoll(); });
async function commitDeviceChange(review, fromDialog = false) {
  if (!invoke || connectionBusy || !connection.connected) return;
  clearTimeout(pollTimer);
  connectionBusy = true;
  renderConnection();
  $('#confirm-eq').disabled = true;
  $('#cancel-eq').disabled = true;
  $('#eq-confirm-result').textContent = 'Writing EQ and checking device readback…';
  try {
    const args = { address: review.address, firmware: review.firmware };
    if (review.action === 'apply') args.profile = review.profile;
    if (review.action === 'spatial') { args.mode = review.value; args.confirmed = true; }
    const command = {spatial:'set_spatial',apply:'apply_eq'}[review.action];
    connection = await invoke(command, args);
    if (fromDialog) $('#eq-confirm').close();
    if (review.action === 'apply') message(`EQ values verified.${connection.eq_write_note ? ` ${connection.eq_write_note}` : ''} Your editor draft is kept.`);
  } catch (error) {
    try { connection = await invoke('headphone_status'); }
    catch { connection = {connected:false}; }
    if (fromDialog) $('#eq-confirm').close();
    message(String(error.message ?? error), true);
  } finally {
    connectionBusy = false;
    $('#confirm-eq').disabled = false;
    $('#cancel-eq').disabled = false;
    renderConnection();
    schedulePoll();
  }
}
$('#eq-confirm-form').onsubmit = event => {
  event.preventDefault();
  if (!writeReview || connectionBusy) return;
  commitDeviceChange(writeReview, true);
};

$('#profile-file').onchange=async event=>{
  pendingCondition = 'Imported · match ANC to the profile’s measurement condition.';
  $('#preview-label').textContent = 'IMPORT PREVIEW';
  const version=++importVersion;pending=null;$('#import-preview').hidden=true;
  const file=event.target.files[0];if(!file)return;
  try{
    if(!invoke)throw Error('File import needs the desktop app. This browser view is a visual preview.');
    if(file.size>256*1024)throw Error('Profile exceeds the 256 KB import limit.');
    const profile=await invoke('import_autoeq',{text:await file.text(),name:file.name.replace(/\.txt$/i,'')});
    if(version!==importVersion)return;
    pending=profile;$('#import-name').textContent=profile.name;
    $('#import-summary').textContent=`${profile.filters.length} bands · ${profile.preamp} dB preamp${profile.disabled_filters.length ? ` · ${profile.disabled_filters.length} disabled rows skipped` : ''}`;
    $('#import-preview').hidden=false;message('Profile validated. Save it to add it to your library.');
  }catch(error){if(version===importVersion)message(String(error.message??error),true);}
  finally{event.target.value='';}
};
$('#save-import').onclick = async () => {
  if (!pending) return;
  try {
    if (await profileLibrary.saveImported(pending, pendingCondition)) {
      pending = null; $('#import-preview').hidden = true;
    }
  } catch (error) { message(String(error.message ?? error), true); }
};
$('#cancel-import').onclick=()=>{++importVersion;pending=null;$('#import-preview').hidden=true;message('Import cancelled. Nothing was saved.');};
$('#reference').onclick=async()=>{try{if(!invoke)throw Error('Load reference needs the desktop app. This preview opens with a Punch draft.');const profile=await invoke('reference_profile');++importVersion;pending=null;$('#import-preview').hidden=true;changeDraft(()=>{useProfile(profile);$('#condition').textContent='Reference tuning · ANC maximum.';});showTab('eq', true);}catch(error){message(String(error.message??error),true);}};
profileLibrary = createProfileLibrary({
  invoke, capture: captureDraft, message, onBusy: renderEqState,
  openDraft(profile, condition, tone) {
    changeDraft(() => useProfile(cloneProfile(profile), condition, tone));
    showTab('eq', true);
  },
  savedDraft(entry) {
    name = entry.profile.name; update(); syncToneControls();
    $('#condition').textContent = entry.condition;
    try { localStorage.setItem(draftKey, JSON.stringify({ version: 1, profile: entry.profile, condition: entry.condition, tone: entry.tone })); }
    catch { /* The named file is saved even if the single working-draft cache is unavailable. */ }
  },
});
eqGraph = createEqGraph($('#response'), {
  state: () => ({ rows, selectedBand, profile: draft(), editable: $('#eq').dataset.mode === 'custom' }),
  select(index) { selectGraphBand(index); update(); },
  open: openBandEditor,
  refresh() { endDraftGesture(); update(); },
  begin(index) {
    endDraftGesture();
    const previous = captureDraftState();
    beginDraftGesture();
    return () => {
      draftGesture = null;
      restoreDraftState(previous);
      selectGraphBand(index); update();
    };
  },
  edit(index, frequency, gain) {
    rows[index].frequency = frequency; rows[index].gain = gain;
    toneValues = null; syncToneControls(); selectGraphBand(index); update();
  },
});
initializeDraft();
profileLibrary.refresh();
new ResizeObserver(() => {
  try { eqGraph.resize(); }
  catch { eqGraph.clear(); }
}).observe($('#response'));
renderConnection();
if (invoke) {
  (async () => {
    try {
      connection = await invoke('headphone_status');
      if (connection.connected) adoptDeviceEq();
      renderConnection();
      if (!connection.connected) await scanDevices();
      schedulePoll();
    } catch (error) { message(String(error.message ?? error), true); }
  })();
}

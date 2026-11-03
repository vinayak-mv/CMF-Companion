// Local named drafts. Every Bluetooth write remains in the main editor flow.
import { tuningProfile, exportProfile } from './tuning.mjs';

const isAndroid = /Android/i.test(navigator.userAgent);

function savedTone(entry) {
  if (!entry.tone) return null;
  try {
    const profile = entry.profile, rebuilt = tuningProfile(entry.tone, undefined, profile.preamp);
    const same = (a, b) => Math.fround(a) === Math.fround(b);
    if (same(profile.preamp, rebuilt.preamp) && profile.filters.length === rebuilt.filters.length
      && profile.filters.every((f, i) => f.kind === rebuilt.filters[i].kind
        && ['frequency', 'gain', 'q'].every(key => same(f[key], rebuilt.filters[i][key])))) return entry.tone;
  } catch { /* Edited profiles reopen in the advanced editor. */ }
  return null;
}

function profileIcon(path) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', path); svg.append(shape);
  return svg;
}

export function createProfileLibrary({ invoke, capture, openDraft, savedDraft, message, onBusy }) {
  const $ = selector => document.querySelector(selector);
  let profiles = [], warnings = [], loadError = '', loading = false, busy = false;
  let page = 0, generation = 0, dialogState = null, removed = null;
  const pageSize = 2;
  const identity = value => value.trim().toLowerCase();
  const matchingName = () => profiles.find(entry => identity(entry.profile.name) === identity($('#saved-profile-name').value));

  function render() {
    const query = identity($('#profile-search').value);
    const matches = profiles.filter(entry => identity(`${entry.profile.name} ${entry.condition}`).includes(query));
    const pages = Math.ceil(matches.length / pageSize);
    page = Math.max(0, Math.min(page, pages - 1));
    $('#library-count').textContent = String(profiles.length);
    $('#library-count').hidden = profiles.length === 0;
    $('#library-results').classList.toggle('is-empty', matches.length === 0);
    $('#refresh-profiles').disabled = !invoke || loading || busy;
    $('#undo-remove-profile').hidden = !removed;
    $('#undo-remove-profile').disabled = busy || loading;
    $('#profiles-previous').disabled = busy || page === 0;
    $('#profiles-next').disabled = busy || page + 1 >= pages;
    $('.library-pager').hidden = pages <= 1;
    $('#profiles-page').textContent = pages > 1 ? `${page + 1} / ${pages}` : '';
    const status = $('#library-status');
    status.textContent = !invoke ? 'Library unavailable' : loading ? 'Loading…'
      : loadError || (warnings.length ? `${warnings.length} unreadable ${warnings.length === 1 ? 'profile' : 'profiles'}`
        : !profiles.length ? 'No saved profiles' : !matches.length ? 'No matching profiles' : '');
    status.classList.toggle('invalid-draft', Boolean(loadError || warnings.length));
    status.title = !invoke ? 'Open the desktop app to access saved profiles.' : loadError || warnings.join('\n');
    status.hidden = Boolean(profiles.length && matches.length && !loading && !loadError && !warnings.length);
    $('#saved-profile-list').replaceChildren();
    for (const entry of matches.slice(page * pageSize, (page + 1) * pageSize)) {
      const card = document.createElement('div'); card.className = 'saved-profile-card';
      const open = document.createElement('button'); open.className = 'saved-profile-open'; open.disabled = busy;
      open.setAttribute('aria-label', `Open ${entry.profile.name} in editor`);
      const name = document.createElement('strong'); name.textContent = entry.profile.name;
      open.title = `${entry.profile.name}\n${entry.profile.filters.length} bands · ${entry.profile.preamp > 0 ? '+' : ''}${entry.profile.preamp} dB preamp${entry.condition ? `\n${entry.condition}` : ''}\nSaved ${new Date(entry.updated_at * 1000).toLocaleString()}`;
      open.append(name, profileIcon('m8 5 5 5-5 5'));
      open.onclick = () => { openDraft(entry.profile, entry.condition, savedTone(entry)); message(`“${entry.profile.name}” opened in the editor. Apply to listen.`); };
      const manage = document.createElement('button'); manage.className = 'manage-profile'; manage.disabled = busy;
      manage.append(profileIcon('M5 10h.01M10 10h.01M15 10h.01'));
      manage.setAttribute('aria-label', `Manage ${entry.profile.name}`); manage.title = 'Manage profile';
      manage.onclick = () => showDialog(entry);
      card.append(open, manage); $('#saved-profile-list').append(card);
    }
  }

  async function refresh() {
    if (!invoke) { render(); return; }
    const ticket = ++generation; loading = true; loadError = ''; render();
    try {
      const result = await invoke('list_library_profiles');
      if (ticket !== generation) return;
      profiles = result.profiles; warnings = result.warnings;
    } catch (error) { if (ticket === generation) loadError = String(error.message ?? error); }
    finally { if (ticket === generation) { loading = false; render(); } }
  }

  function dialogButtons() {
    const manage = dialogState?.mode === 'manage';
    $('#update-profile').hidden = manage || !matchingName();
    $('#update-profile').disabled = busy;
    $('#export-profile').hidden = !manage;
    $('#export-profile').disabled = busy;
    $('#save-profile').textContent = manage ? 'Save changes' : 'Save new';
    $('#remove-profile').hidden = !manage;
    for (const element of $('#profile-form').querySelectorAll('button, input')) element.disabled = busy;
  }

  function setBusy(value) { busy = value; dialogButtons(); render(); onBusy(); }
  function dialogError(error) { $('#profile-dialog-error').textContent = String(error.message ?? error); $('#profile-dialog-error').hidden = false; }

  function showDialog(entry = null) {
    if (!invoke || busy) return;
    try {
      const draft = entry ? { profile: entry.profile, condition: entry.condition, tone: entry.tone } : capture();
      dialogState = { mode: entry ? 'manage' : 'save', entry, draft: JSON.parse(JSON.stringify(draft)) };
      $('#profile-dialog-title').textContent = entry ? 'Manage profile' : 'Save profile';
      $('#profile-dialog-summary').textContent = `${draft.profile.filters.length} bands · ${draft.profile.preamp} dB preamp`;
      $('#saved-profile-name').value = draft.profile.name;
      $('#saved-profile-notes').value = draft.condition || '';
      $('#profile-dialog-error').hidden = true;
      dialogButtons(); $('#profile-dialog').showModal(); $('#saved-profile-name').focus(); $('#saved-profile-name').select();
    } catch (error) { message(String(error.message ?? error), true); }
  }

  async function save(update = false) {
    if (busy || !dialogState || !$('#profile-form').reportValidity()) return;
    const existing = dialogState.mode === 'manage' ? dialogState.entry : update ? matchingName() : null;
    if (update && !existing) { dialogError('No matching profile. Refresh the library and try again.'); return; }
    if (dialogState.mode === 'save' && !update && matchingName()) { dialogError('That name is already saved. Choose Update existing or enter a new name.'); return; }
    const captured = dialogState.draft;
    const request = { id: existing?.id ?? null, expected_revision: existing?.revision ?? null,
      profile: { ...captured.profile, name: $('#saved-profile-name').value.trim() },
      condition: $('#saved-profile-notes').value, tone: captured.tone };
    const isEditor = dialogState.mode === 'save';
    setBusy(true); $('#profile-dialog-error').hidden = true;
    try {
      const result = await invoke('save_library_profile', { request });
      $('#profile-dialog').close();
      if (isEditor) savedDraft(result);
      page = 0;
      message(`“${result.profile.name}” saved on this computer.`);
      await refresh();
    } catch (error) { dialogError(error); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (busy || !dialogState?.entry) return;
    const entry = dialogState.entry;
    setBusy(true);
    try {
      await invoke('delete_library_profile', { id: entry.id, revision: entry.revision });
      removed = entry; $('#profile-dialog').close();
      message(`“${entry.profile.name}” removed. Undo remove is available in Profiles.`);
      await refresh();
    } catch (error) { dialogError(error); }
    finally { setBusy(false); }
  }

  $('#profile-form').onsubmit = event => { event.preventDefault(); save(); };
  $('#update-profile').onclick = () => save(true);
  $('#remove-profile').onclick = remove;
  $('#export-profile').onclick = async () => {
    const profile = dialogState?.entry?.profile;
    if (!profile) return;
    const filename = `${profile.name.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'cmf-profile'}.txt`;
    try {
      if (isAndroid && invoke) {
        const saved = await invoke('export_profile_file', { name: filename, text: exportProfile(profile) });
        message(saved ? `“${profile.name}” exported.` : 'Export cancelled.');
        return;
      }
      const url = URL.createObjectURL(new Blob([exportProfile(profile)], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      message(`Export requested. The file contains “${profile.name}”.`);
    } catch (error) { message(String(error.message ?? error), true); }
  };
  $('#cancel-profile').onclick = () => { if (!busy) $('#profile-dialog').close(); };
  $('#profile-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  $('#saved-profile-name').oninput = () => { $('#profile-dialog-error').hidden = true; dialogButtons(); };
  $('#refresh-profiles').onclick = refresh;
  $('#profile-search').oninput = () => { page = 0; render(); };
  $('#profiles-previous').onclick = () => { --page; render(); };
  $('#profiles-next').onclick = () => { ++page; render(); };
  $('#undo-remove-profile').onclick = async () => {
    if (!removed || busy) return;
    setBusy(true);
    try {
      await invoke('restore_library_profile', { id: removed.id, revision: removed.revision });
      message(`“${removed.profile.name}” restored.`); removed = null; page = 0; await refresh();
    } catch (error) { message(String(error.message ?? error), true); }
    finally { setBusy(false); }
  };
  render();
  return { openSave: () => showDialog(), refresh, get busy() { return busy; } };
}

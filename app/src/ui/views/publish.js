// Publish to the Steam Workshop through the Python Steam helper.
import { h, clear, btn, toast, modal, fmtBytes } from '../dom.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { state, game, saveSettings } from '../state.js';
import { VISIBILITY, LIMITS } from '../../core/constants.js';
import { pngToDataUrl, renderThumbnail } from '../../three/thumbnail.js';
import { workshopFolderFor } from '../item.js';

const steamTagsFor = (item) => {
  const out = new Set();
  for (const g of item.meta.tagGuids) {
    const t = state.collections.tagByGuid.get(g);
    if (t) out.add(t.short);
  }
  const p = ['Floor', 'Ceiling', 'Wall'][item.meta.placement];
  if (p === 'Wall') out.add('Hanging');
  if (p === 'Ceiling') out.add('Ceiling');
  return [...out];
};

export function openPublishDialog(item, { onDone, save } = {}) {
  const g = game();
  const m = item.meta;
  const isUpdate = !!m.guid;
  const f = {
    title: h('input.input', { value: m.name, maxlength: 128 }),
    description: h('textarea.input', { rows: 5, value: m.description }),
    visibility: h('select.input', VISIBILITY.map((v) => h('option', { value: v.id, selected: v.id === (m.visibility ?? 2) }, v.name))),
    tags: h('input.input', { value: steamTagsFor(item).join(', ') }),
    change: h('input.input', { value: m.changeNote || '', placeholder: isUpdate ? 'What changed in this version' : 'Optional' }),
  };
  const log = h('div.small.muted', { style: { whiteSpace: 'pre-line', minHeight: '18px' } });
  const bar = h('div.progress.hidden', h('i'));
  const status = h('div.row.small');
  const body = h('div',
    h('div.row', { style: { alignItems: 'flex-start', gap: '14px', marginBottom: '12px' } },
      item.thumbnail ? h('img', { src: pngToDataUrl(item.thumbnail), style: { width: '96px', height: '96px', borderRadius: '8px', background: '#101318', objectFit: 'contain', flex: 'none' } }) : null,
      h('div.grow',
        h('div', { style: { fontWeight: 650, fontSize: '14px' } }, isUpdate ? `Update workshop item #${m.guid}` : 'Publish a new workshop item'),
        h('div.small.muted', isUpdate ? 'Uploads the current version over the existing item. Subscribers get it automatically.' : 'Tip: publish as Private first, test it in game, then switch it to Public.'),
        status)),
    h('label.field', h('span', 'Title'), f.title),
    h('label.field', h('span', 'Description'), f.description),
    h('div.grid2', h('label.field', h('span', 'Visibility'), f.visibility), h('label.field', h('span', 'Change note'), f.change)),
    h('label.field', h('span', 'Steam tags'), f.tags, h('div.field-hint', 'Comma-separated. Filled from your item tags, the way the official kit does it.')),
    bar, log);

  if (!g?.steamDll) status.append(h('span.badge.red', 'steam_api64.dll not found'), h('span.faint', 'Install the House Flipper Content Creator (it comes with the game).'));
  else if (!state.env.python) status.append(h('span.badge.red', 'Python not found'), h('span.faint', 'Needed to talk to Steam. Set it in Settings.'));
  else {
    status.append(h('span.spinner'), h('span.faint', 'Checking Steam…'));
    api.steam({ command: 'status', args: { dll: g.steamDll } })
      .then((r) => clear(status).append(h('span.badge.green', 'Steam ready'), h('span.faint', `Signed in as ${r.user}`)))
      .catch((e) => clear(status).append(h('span.badge.red', 'Steam not ready'), h('span.faint', e.message)));
  }

  let running = false;
  const doUpload = async (close, uploadBtn) => {
    if (running) return;
    running = true;
    uploadBtn.disabled = true;
    bar.classList.remove('hidden');
    const setP = (pct, text) => { bar.firstChild.style.width = pct + '%'; if (text) log.textContent = text; };
    const off = api.onProgress((p) => {
      if (p.kind !== 'steam') return;
      if (p.event === 'progress') setP(p.percent || 0, `${p.stage}${p.total ? ` · ${fmtBytes(p.bytes)} of ${fmtBytes(p.total)}` : ''}`);
      if (p.event === 'created') log.textContent = `Created workshop item #${p.fileId}`;
    });
    try {
      m.name = f.title.value.trim() || m.name;
      m.description = f.description.value;
      m.visibility = +f.visibility.value;
      m.changeNote = f.change.value;
      const base = { dll: g.steamDll, language: state.settings.steamLanguage };
      if (!m.guid) {
        setP(3, 'Creating the workshop item…');
        const r = await api.steam({ command: 'publish', args: { ...base, createOnly: true } });
        m.guid = r.fileId;
        if (r.needsLegal) toast('Accept the Workshop agreement', 'Steam requires you to accept the Workshop legal agreement before the item becomes visible.', 'warn', 10000);
        // save right away so the id is never lost
        await save?.();
      }
      setP(8, 'Packing the item…');
      const out = item.build();
      if (out.bytes.length > LIMITS.maxPackageBytes) throw new Error(`Package is ${fmtBytes(out.bytes.length)}; the limit is 100 MB`);
      // Steam preview: bigger render looks better on the workshop page, must stay under 1 MB
      let preview = item.thumbnail;
      try {
        if (item.settings.thumbAuto) {
          const big = renderThumbnail(item.model, { size: 512, angle: item.settings.thumbAngle, background: item.settings.thumbBackground === 'transparent' ? 'gradient' : item.settings.thumbBackground });
          if (big.length < LIMITS.maxPreviewBytes) preview = big;
        }
      } catch { /* fall back to the thumbnail */ }
      const staged = await api.stageUpload({ bytes: out.bytes, fileName: item.fileName(), previewBytes: preview });
      setP(12, 'Uploading to Steam…');
      const tags = f.tags.value.split(',').map((s) => s.trim()).filter(Boolean);
      const r = await api.steam({ command: 'publish', args: {
        ...base, fileId: m.guid, title: m.name, description: m.description, visibility: m.visibility,
        tags, contentDir: staged.contentDir, preview: staged.preview, changeNote: m.changeNote, subscribe: true,
      } });
      item.published = { fileId: r.fileId, at: Date.now(), visibility: m.visibility, size: out.bytes.length };
      await save?.();
      setP(100, 'Done');
      if (r.needsLegal) toast('Accept the Workshop agreement', 'Open the item page on Steam and accept the agreement to make it visible.', 'warn', 10000);
      toast('Published', `Workshop item #${r.fileId} (${VISIBILITY[m.visibility].name}). You are subscribed, so Steam will download it for the game.`, 'ok', 9000);
      close();
      onDone?.();
      modal({
        title: 'Published',
        body: h('div', h('p', `"${m.name}" is on the Workshop as item #${r.fileId}.`),
          h('p.muted', 'Steam downloads it in the background. Restart the game if it was running, then look for it in the shop under its category.')),
        foot: (c) => [btn('Open on Steam', () => api.openExternal(r.url), { ic: 'external' }), btn('Close', c, { cls: 'primary' })],
      });
    } catch (e) {
      log.textContent = '✖ ' + e.message;
      toast('Upload failed', e.message, 'err', 10000);
    } finally {
      off();
      running = false;
      uploadBtn.disabled = false;
    }
  };

  modal({
    title: isUpdate ? 'Update on Steam Workshop' : 'Publish to Steam Workshop',
    body,
    wide: false,
    foot: (close) => {
      const up = btn(isUpdate ? 'Upload update' : 'Publish', () => doUpload(close, up), { cls: 'primary', ic: 'upload' });
      return [
        isUpdate ? btn('Install locally (test)', () => quickInstall(item), { ic: 'download', title: 'Overwrite your installed copy so you can test without uploading' }) : null,
        h('div.grow'),
        btn('Cancel', close),
        up,
      ];
    },
  });
  void saveSettings;
}

/** Replace the installed workshop copy of this item with the current build, keeping a backup. */
export async function quickInstall(item) {
  const id = item.meta.guid;
  const dir = workshopFolderFor(id);
  if (!dir) { toast('Workshop folder not found', '', 'err'); return; }
  const st = await api.statPath({ path: dir });
  if (!st.exists) { toast('Not installed', `Subscribe to #${id} first so Steam creates its folder.`, 'warn', 7000); return; }
  const ok = await api.confirm({
    message: `Replace the installed copy of #${id}?`,
    detail: `${dir}\n\nThe current file is kept as a .bak. Steam puts the published version back the next time the item updates. Close the game first.`,
    buttons: ['Replace', 'Cancel'],
  });
  if (ok !== 0) return;
  const list = await api.listDir({ path: dir, exts: ['hfcontent'] });
  for (const f of list) await api.copyFile({ from: f.path, to: f.path + '.bak' });
  const target = list[0]?.path || `${dir}\\${item.fileName()}`;
  const out = item.build();
  await api.writeFile({ path: target, bytes: out.bytes });
  toast('Installed for testing', `${target}\nStart House Flipper to try it.`, 'ok', 7000);
}

export { icon };

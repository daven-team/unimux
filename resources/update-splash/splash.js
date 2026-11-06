'use strict';
const $ = (id) => document.getElementById(id);

// "1.1.4 -> 1.2.0" as two version labels with a drawn chevron between them (a text arrow glyph looked out of place).
function setVersions(text) {
  const el = $('versions');
  const parts = String(text).split(/\s*→\s*/);
  el.replaceChildren();
  parts.forEach((part, i) => {
    if (i > 0) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 12 12');
      svg.setAttribute('class', 'versions-arrow');
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', 'M4.5 2.5L8 6l-3.5 3.5');
      svg.append(path);
      el.append(svg);
    }
    const span = document.createElement('span');
    span.className = i === parts.length - 1 && parts.length > 1 ? 'versions-to' : 'versions-from';
    span.textContent = part;
    el.append(span);
  });
  el.setAttribute('aria-label', parts.join(' - '));
}

function render(state) {
  document.querySelector('.card').dataset.stage = state.stage;
  const percent = Math.round(state.percent);
  $('fill').style.width = state.percent + '%';
  $('percent').textContent = percent + '%';
  $('meter').setAttribute('aria-valuenow', String(percent));
  $('status').textContent = state.message || '';
  if (state.title) $('title').textContent = state.title;
  if (state.versions) setVersions(state.versions);
  if (state.hint) $('hint').textContent = state.hint;
  $('percent').hidden = state.stage === 'checking';

  const failed = state.stage === 'error';
  const asking = state.stage === 'ask';
  $('actions').hidden = !failed && !asking;
  // The startup prompt brings its own button labels; the update window's error state keeps the ones from init().
  if (asking && state.primary) { $('open').textContent = state.primary; $('close').textContent = state.secondary || ''; $('open').focus(); }
  // The X is there at every stage; only the app's own startup window withholds it once the installer is being started.
  $('dismiss').hidden = state.closable === false;
  if (failed && state.detail) $('hint').textContent = state.detail;
}

document.addEventListener('keydown', (event) => { if (event.key === 'Escape') window.updateSplash.close(); });

window.updateSplash.init().then((info) => {
  $('title').textContent = info.title;
  $('hint').textContent = info.hint;
  setVersions(info.fromVersion + ' → ' + info.version);
  $('open').textContent = info.open;
  $('close').textContent = info.close;
  $('open').addEventListener('click', () => window.updateSplash.open());
  $('close').addEventListener('click', () => window.updateSplash.close());
  $('dismiss').addEventListener('click', () => window.updateSplash.close());
  $('dismiss').title = info.close;
  $('dismiss').setAttribute('aria-label', info.close);
  render(info.state || { stage: 'preparing', percent: 0, message: '' });
  window.updateSplash.onState(render);
});

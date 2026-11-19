const $ = selector => document.querySelector(selector);
const profiles = { seller: [1920, 1080], compact: [1366, 768], customer: [1280, 800], scaled: [1536, 864] };
const surfaces = { register: '/register', counter: '/counter', kitchen: '/kitchen', kiosk: '/kiosk', pickup: '/pickup', ops: '/ops', sales: '/sales' };
const profile = $('#lab-profile');
const surface = $('#lab-surface');
const width = $('#lab-width');
const height = $('#lab-height');
const preview = $('#lab-preview');
const shell = $('#lab-shell');
const frame = $('#lab-frame');
const results = $('#lab-results');
const small = $('#lab-small-targets');
const exportButton = $('#lab-export');
let framePath;
let diagnostics;
let resizeFrame;
let pendingMeasure;

function popupUrl() {
  const url = new URL(surfaces[surface.value], location.origin);
  url.searchParams.set('lab', '1');
  return url;
}

function fit() {
  const w = Number(width.value), h = Number(height.value);
  if (![w, h].every(Number.isInteger) || w < 320 || w > 3840 || h < 300 || h > 2400) return;
  const scale = Math.min(1, Math.max(0.06, (preview.clientWidth - 20) / w), 940 / h);
  shell.style.width = `${w * scale}px`;
  shell.style.height = `${h * scale}px`;
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  frame.style.transform = `scale(${scale})`;
  $('#lab-context').textContent = `${w} × ${h} CSS pixels · ${Math.round(scale * 100)}% preview scale. Layout inside the preview runs at the selected dimensions. Use sample transactions only.`;
  clearTimeout(pendingMeasure);
  pendingMeasure = setTimeout(measure, 350);
}

function configure() {
  const preset = profiles[profile.value];
  if (preset) { width.value = preset[0]; height.value = preset[1]; }
  width.disabled = height.disabled = Boolean(preset);
  const url = popupUrl();
  $('#lab-open').href = url.pathname;
  if (framePath !== url.href) {
    framePath = url.href;
    frame.src = framePath;
    diagnostics = null;
    exportButton.disabled = true;
    results.replaceChildren(metric('Frame', 'Waiting for the surface to load'));
    small.replaceChildren();
  }
  const configUrl = new URL(location.href);
  configUrl.searchParams.set('profile', profile.value);
  configUrl.searchParams.set('surface', surface.value);
  if (!preset) {
    configUrl.searchParams.set('width', width.value);
    configUrl.searchParams.set('height', height.value);
  } else { configUrl.searchParams.delete('width'); configUrl.searchParams.delete('height'); }
  history.replaceState(null, '', configUrl);
  fit();
}

function metric(label, value) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  row.append(dt, dd);
  return row;
}

function measure() {
  try {
    const doc = frame.contentDocument, window = frame.contentWindow;
    if (!doc?.documentElement || window.location.protocol === 'about:' || doc.readyState === 'loading') {
      results.replaceChildren(metric('Frame', 'Waiting for the surface to load'));
      return;
    }
    if (window.location.pathname !== new URL(framePath).pathname) {
      diagnostics = null;
      exportButton.disabled = true;
      results.replaceChildren(metric('Frame', 'The preview moved to another page. Select its surface to measure it.'));
      small.replaceChildren();
      return;
    }
    const root = doc.documentElement;
    const horizontalOverflow = Math.max(0, root.scrollWidth - root.clientWidth);
    const selector = surface.value === 'register' ? '#reg-quick button,#reg-products .reg-key,#reg-tender'
      : 'button, select, input:not([type=hidden]), a.button, [role=button]';
    const checked = [...doc.querySelectorAll(selector)].flatMap(target => {
      const rect = target.getBoundingClientRect();
      const style = window.getComputedStyle(target);
      if (!rect.width || !rect.height || style.visibility === 'hidden' || !target.getClientRects().length) return [];
      const label = (target.getAttribute('aria-label') || target.labels?.[0]?.textContent || target.textContent || target.tagName).trim().replace(/\s+/g, ' ').slice(0, 100);
      return [{ label, width: Math.round(rect.width * 10) / 10, height: Math.round(rect.height * 10) / 10 }];
    });
    const underSize = checked.filter(entry => entry.width < 44 || entry.height < 44);
    diagnostics = { measuredAt: new Date().toISOString(), surface: surface.value, profile: profile.value,
      viewport: { width: window.innerWidth, height: window.innerHeight }, horizontalOverflow,
      checkedTargetCount: checked.length, touchTargetGoalCssPixels: 44, belowTouchTargetGoal: underSize };
    results.replaceChildren(metric('Measured viewport', `${window.innerWidth} × ${window.innerHeight}`),
      metric('Horizontal page overflow', `${horizontalOverflow} px`), metric('Touch controls measured', String(checked.length)),
      metric('Below 44 × 44 CSS px', checked.length ? String(underSize.length) : 'None measured'));
    small.replaceChildren(...underSize.slice(0, 8).map(entry => {
      const li = document.createElement('li');
      li.textContent = `${entry.label} · ${entry.width} × ${entry.height}`;
      return li;
    }));
    exportButton.disabled = false;
  } catch {
    diagnostics = null;
    exportButton.disabled = true;
    results.replaceChildren(metric('Measurements unavailable', 'Open the surface directly and reload the preview.'));
    small.replaceChildren();
  }
}

for (const control of [profile, surface, width, height]) control.addEventListener('change', () => {
  if (profile.value === 'custom' && (!width.reportValidity() || !height.reportValidity())) return;
  configure();
});
$('#lab-rotate').addEventListener('click', () => {
  if (Number(height.value) < Number(width.min) || Number(width.value) > Number(height.max)) {
    $('#lab-context').textContent = 'Rotate supports widths of 300–2400 and heights of 320–2400 for this profile. Set custom dimensions within that range.';
    return;
  }
  [width.value, height.value] = [height.value, width.value];
  profile.value = 'custom';
  configure();
});
$('#lab-measure').addEventListener('click', measure);
frame.addEventListener('load', () => { clearTimeout(pendingMeasure); pendingMeasure = setTimeout(measure, 700); });
exportButton.addEventListener('click', () => {
  if (!diagnostics) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnostics, null, 2) + '\n'], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `fold-${diagnostics.surface}-${diagnostics.viewport.width}x${diagnostics.viewport.height}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(fit);
}).observe(preview);
const settings = new URLSearchParams(location.search);
if (Object.hasOwn(surfaces, settings.get('surface'))) surface.value = settings.get('surface');
if (Object.hasOwn(profiles, settings.get('profile'))) profile.value = settings.get('profile');
if (settings.get('profile') === 'custom') {
  const w = Number(settings.get('width')), h = Number(settings.get('height'));
  if (Number.isInteger(w) && Number.isInteger(h) && w >= 320 && w <= 3840 && h >= 300 && h <= 2400) {
    profile.value = 'custom'; width.value = w; height.value = h;
  }
}
configure();

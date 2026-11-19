const groups = document.querySelector('#change-group');
const search = document.querySelector('#change-search');
const status = document.querySelector('#change-count');
const result = document.querySelector('#change-list');
const project = 'https://github.com/marioG1025/fold-llp-kiosk/blob/main/';
let release = [];

function element(tag, text) {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  return node;
}

function filter() {
  const words = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const list = release.flatMap(group => {
    if (groups.value && group.id !== groups.value) return [];
    const entries = group.changes.filter(entry => {
      const haystack = `${group.name} ${entry.description} ${entry.evidence.join(' ')}`.toLowerCase();
      return words.every(word => haystack.includes(word));
    });
    return entries.length ? [{ ...group, entries }] : [];
  });
  const count = list.reduce((sum, group) => sum + group.entries.length, 0);
  const total = release.reduce((sum, group) => sum + group.changes.length, 0);
  status.textContent = `${count} of ${total} shipped changes`;
  result.replaceChildren(...list.map(group => {
    const panel = element('section'); panel.className = 'wb-panel';
    const header = element('h2', group.name);
    const list = element('ol');
    for (const entry of group.entries) {
      const row = element('li', entry.description);
      row.value = entry.number;
      const evidence = element('small');
      for (const [index, file] of entry.evidence.entries()) {
        if (index) evidence.append(' · ');
        const link = element('a', file);
        link.href = project + file.split('/').map(encodeURIComponent).join('/');
        evidence.append(link);
      }
      row.append(evidence); list.append(row);
    }
    panel.append(header, list); return panel;
  }));
  if (!count) result.append(element('p', 'No changes match your search.'));
}

fetch('/improvements.json', { cache:'no-store' }).then(response => {
  if (!response.ok) throw new Error('Release notes could not be loaded.');
  return response.json();
}).then(data => {
  release = data;
  for (const area of release) groups.append(new Option(area.name, area.id));
  filter();
}).catch(() => { status.textContent = 'Release notes are temporarily unavailable.'; });

groups.addEventListener('change', filter);
search.addEventListener('input', filter);

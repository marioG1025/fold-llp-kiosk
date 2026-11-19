import { groups } from './menu-items.mjs';

const coffee = { id: 'coffee', name: 'Coffee' };
const signature = { id: 'signature', name: 'Specialty' };
const tea = { id: 'tea', name: 'Tea & Matcha' };
const refreshers = { id: 'refreshers', name: 'Refreshers' };
const patisserie = { id: 'patisserie', name: 'Patisserie' };
const kitchen = { id: 'kitchen', name: 'Kitchen' };
const seasonal = { id: 'seasonal', name: 'Seasonal' };
const categories = [coffee, signature, tea, refreshers, patisserie, kitchen];

const milk = {
  id: 'milk',
  name: 'Milk',
  required: true,
  options: [
    { id: 'whole', name: 'Whole milk', priceCents: 0 },
    { id: 'oat', name: 'Oat milk', priceCents: 75 },
    { id: 'almond', name: 'Almond milk', priceCents: 75 },
  ],
};
const shot = {
  id: 'shot',
  name: 'Espresso',
  required: false,
  options: [{ id: 'extra', name: 'Extra shot', priceCents: 100 }],
};
const warmed = {
  id: 'warmth',
  name: 'Serving preference',
  required: false,
  options: [{ id: 'warmed', name: 'Warmed', priceCents: 0 }],
};

function item(id, name, category, priceCents, description, modifiers = []) {
  return { id, name, description, categoryId: category.id, priceCents, image: `/images/${id}.webp`, modifiers };
}

const coreItems = [
  item('flat-white', 'Flat White', coffee, 450, 'Double ristretto and silky steamed milk.', [milk, shot]),
  item('iced-matcha', 'Iced Matcha Latte', tea, 625, 'Stone-ground matcha, cold milk and ice.', [milk]),
  item('almond-croissant', 'Almond Croissant', patisserie, 575, 'Twice baked with almond cream and toasted flakes.', [warmed]),
  item('iced-vanilla', 'Iced Vanilla Latte', coffee, 575, 'House espresso, vanilla bean and cold milk.', [milk, shot]),
  item('raspberry-croissant', 'Raspberry Croissant', patisserie, 600, 'Laminated pastry with bright raspberry filling.', [warmed]),
  item('pain-au-chocolat', 'Pain au Chocolat', patisserie, 525, 'Buttery layers wrapped around dark chocolate.', [warmed]),
  item('egg-focaccia', 'Egg & Cheddar Focaccia', kitchen, 850, 'Soft egg, aged cheddar and herb aioli on focaccia.'),
  item('granola-bowl', 'Yogurt & Granola Bowl', kitchen, 725, 'Greek yogurt, toasted oat granola and seasonal berries.'),
  item('chocolate-cookie', 'Chocolate Chunk Cookie', patisserie, 375, 'Brown butter, dark chocolate and a pinch of sea salt.'),
];

const modifierById = { milk, shot, warmed };
const fullMenu = [...coreItems, ...groups.flatMap(({ atlas, items }) => items.map(([id, name, categoryId, priceCents, description, ...modifierIds], index) => ({
  id, name, categoryId, priceCents, description,
  modifiers: modifierIds.filter(Boolean).map(modifier => modifierById[modifier]),
  photo: { atlas, column: index % 4, row: Math.floor(index / 4) },
})))];

export const catalogs = [
  {
    version: 1,
    name: 'Core Menu',
    description: 'Everyday coffee, pastry and kitchen staples.',
    pickup: { title: 'Collect at the bar', description: 'We’ll call your order number at the pickup counter.' },
    categories,
    items: fullMenu,
  },
  {
    version: 2,
    name: 'Seasonal Menu',
    description: 'Adds Maple Cloud Latte and Pear Frangipane, updates the Flat White price and changes pickup guidance.',
    pickup: { title: 'Collect at the Fold pickup shelf', description: 'Watch for your order number on the display, then head to the pickup shelf.' },
    categories: [...categories, seasonal],
    items: [
      { ...coreItems[0], priceCents: 475 },
      ...fullMenu.slice(1),
      item('maple-cloud-latte', 'Maple Cloud Latte', seasonal, 650, 'Espresso and maple topped with a soft milk foam.', [milk, shot]),
      item('pear-frangipane', 'Pear Frangipane Tart', seasonal, 675, 'Poached pear and almond cream in a crisp pastry shell.'),
    ],
  },
];

export const devices = [
  { id: 'market-01', name: 'Kiosk 01', storeId: 'market', storeName: 'Market Street', channel: 'stable' },
  { id: 'market-02', name: 'Kiosk 02', storeId: 'market', storeName: 'Market Street', channel: 'beta' },
  { id: 'north-01', name: 'Kiosk 01', storeId: 'north', storeName: 'North Loop', channel: 'stable' },
  { id: 'north-02', name: 'Kiosk 02', storeId: 'north', storeName: 'North Loop', channel: 'beta' },
  { id: 'lake-01', name: 'Kiosk 01', storeId: 'lake', storeName: 'Lakeside', channel: 'stable' },
  { id: 'lake-02', name: 'Kiosk 02', storeId: 'lake', storeName: 'Lakeside', channel: 'beta' },
];

// The live layer renders the catalog used by the kiosk host, including the authoritative prices.
export function layerSource(menu) {
  const literal = JSON.stringify(JSON.stringify(menu));
  return `import { setStr } from "./llp";

export function llp_schema(): i32 { return 1; }
export function llp_view(): void { setStr("catalog", ${literal}); }
`;
}

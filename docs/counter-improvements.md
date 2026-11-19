# Counter display, terminal verification and sales reports

1. Dedicated customer display separates the customer view from staff controls. `public/counter.html`
2. Register chooser pairs the counter display with a specific simulated terminal. `public/counter.js`
3. Register pairing persists in a shareable device URL and falls back to a valid terminal. `public/counter.js`
4. The display requests a current ticket on opening, so a screen can join a sale in progress. `public/counter.js`
5. Welcome, active ticket, payment and receipt states give the customer phase-specific instructions. `public/counter.js`
6. The buyer can verify line quantities, modifier names, line prices and service type while the cashier edits. `public/counter.js`
7. A transaction breakdown separates discounts, tax, tips and the total and marks a pending quote. `public/counter.js`
8. At checkout, the customer display shows the pickup number and the versioned pickup instructions. `public/counter.js`
9. The display clears stale ticket content if the register stops responding, then tries to reconnect. `public/counter.js`
10. The display projects only bounded customer-visible values and uses text rendering for live fields. `public/counter.js`
11. Optional fullscreen keeps the facing screen usable as a dedicated counter appliance. `public/counter.html`
12. High-contrast responsive counter typography and de-duplicated live announcements support at-a-glance and assistive reading. `public/counter.css`, `public/counter.js`
13. Terminal Lab offers documented seller, customer, compact and scaled browser profiles. `public/terminal-lab.html`
14. Custom dimensions and rotation test layouts beyond the built-in profiles. `public/terminal-lab.js`
15. The same preview can load the register, customer screen, kitchen board, kiosk, pickup, operations or sales surface. `public/terminal-lab.js`
16. Fit-to-window preview retains the embedded page's actual CSS layout dimensions. `public/terminal-lab.js`
17. Diagnostics measure horizontal overflow using the embedded document. `public/terminal-lab.js`
18. The preview measures primary register touch targets against 44 CSS pixels and identifies undersized controls. `public/terminal-lab.js`
19. Diagnostics export a JSON snapshot suitable for comparing builds and viewport regressions. `public/terminal-lab.js`
20. Sales report filters by store and supports today, recent periods and a custom UTC range. `public/sales.js`
21. Opened report date ranges and store filters can be shared as URLs. `public/sales.js`
22. The report breaks down gross, discounts, tax, tips, money collected, refunds and net collections. `public/sales.js`
23. A daily trend chart and detailed daily table expose the timing of sales and later refunds. `public/sales.js`
24. The store reconciliation table compares collected, refunded and net amounts across locations. `public/sales.js`
25. The selected report can be downloaded as CSV or printed with the input controls removed. `public/sales.js`, `public/sales.css`

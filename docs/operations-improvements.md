# Kitchen, operations, and pickup improvements

| # | Implemented behavior | Source |
| --- | --- | --- |
| 1 | The kitchen workboard separates New, Preparing, and Ready tickets and shows the count in each lane. | [Workboard and `render`](../public/kitchen.js) |
| 2 | A store selector limits the board to one location and saves that selection in the URL. | [`storeControl`, `matches`, and `saveFilters`](../public/kitchen.js) |
| 3 | Drinks, Patisserie, and Kitchen station filters route tickets using the item’s menu category and highlight the matching quantities. | [`stationOf`, `matches`, and `lineMarkup`](../public/kitchen.js) |
| 4 | Mixed-station tickets retain their other items and identify when a station’s bump action affects the whole ticket. | [`ticket`](../public/kitchen.js) |
| 5 | Each ticket shows a live elapsed clock. Ready tickets show time since they were marked Ready. | [`elapsed`, `ticket`, and the clock updater](../public/kitchen.js) |
| 6 | Waiting tickets at eight minutes or more receive an overdue label and contribute to the overdue count. | [`isLate` and `render`](../public/kitchen.js) |
| 7 | Overdue only narrows the screen to delayed work and preserves the choice in the URL. | [`overdueControl` and `saveFilters`](../public/kitchen.js) |
| 8 | Kitchen cards expose line quantities, selected modifiers, service type, store, and the total number of items. | [`lineMarkup` and `ticket`](../public/kitchen.js) |
| 9 | Cashier ticket notes appear separately above the prep lines. | [`ticket`](../public/kitchen.js) |
| 10 | A large action on each card starts prep, marks the order Ready, or records handoff. A pending action cannot submit again. | [`bump`](../public/kitchen.js) |
| 11 | Left and right arrows select a ticket and B bumps it. The selected ticket has a visible outline and keyboard focus follows it when possible. | [`select`, `focusSelected`, and keyboard handler](../public/kitchen.js) |
| 12 | Long item and modifier lists scroll inside the card, with the bump control outside that scroll area. Larger wall displays fit two cards per lane. | [Card and lane layout](../public/kitchen.css) |
| 13 | The board receives live order changes, polls as a fallback, and disables bump controls while its order feed is offline. | [`refresh` and `initialize`](../public/kitchen.js) |
| 14 | Availability opens a separate stock view for each store and displays its current state. | [`readStock` and `renderStock`](../public/ops.tools.js) |
| 15 | Stock can be searched by product or category and narrowed to unavailable items or limited quantities. | [Stock controls](../public/ops.html) and [`renderStock`](../public/ops.tools.js) |
| 16 | Staff can mark a product unavailable and restore it. The view distinguishes staff blocks from exhausted stock. | [`renderStock` and `writeStock`](../public/ops.tools.js) |
| 17 | Staff can set a finite stock quantity, see the remaining count, or clear the quantity for unlimited stock. | [`writeStock`](../public/ops.tools.js) |
| 18 | A full demo refund requires confirmation and a reason. Uncertain responses can be retried using the original request key. | [`reviewRefund` and `recordRefund`](../public/ops.js) |
| 19 | Refunded sales have a dedicated order filter and display the amount, reason, and recorded time. They cannot be advanced from the queue. | [`renderOrders` and `viewOrder`](../public/ops.js) |
| 20 | Sales totals can be filtered by store and inclusive UTC dates, with charges, discounts, taxes, tips, refunds, and net collections displayed. | [`readReport` and report form handler](../public/ops.tools.js) |
| 21 | The sales screen breaks the filtered figures down by store and calendar day. | [`breakdown`](../public/ops.tools.js) |
| 22 | The download button exports CSV with the same filters as the displayed report. | [`readReport`](../public/ops.tools.js) |
| 23 | The public pickup display can enter and exit full screen from its toolbar. | [Fullscreen control](../public/pickup.js) |
| 24 | On supported devices, the pickup attendant can keep the screen awake. The display reacquires the lock when visible again and reports when the lock is unavailable. | [`acquireWakeLock`](../public/pickup.js) |
| 25 | Pickup numbers newly moved to Ready receive a one-minute highlight and a screen-reader announcement. | [`refresh` and highlight expiry](../public/pickup.js) |

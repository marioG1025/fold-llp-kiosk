# POS backend improvements

The register, kiosk, operations console, and kitchen share a loopback API and the same SQLite sales ledger. Receipts retain their signed menu version and the amounts recorded at checkout.

| # | Implemented behavior | Code | Integration coverage |
| --- | --- | --- | --- |
| 1 | Terminals can fetch the canonical tender limits, note limit, tax rate, and discount menu through the POS policy endpoint. | [server](../server.mjs), [orders](../orders.mjs) | Register adjustments |
| 2 | A cashier can apply approved 10% staff or 15% service-recovery discounts. The server computes the amount from the selected preset. | [orders](../orders.mjs) | Register adjustments |
| 3 | A discount reduces the taxable subtotal. The receipt exposes the adjusted base and rounds the resulting tax in whole cents. | [orders](../orders.mjs) | Register adjustments |
| 4 | Cashiers can add a tip after tax. The server validates the entered cents and caps tips at $50. | [orders](../orders.mjs) | Register adjustments |
| 5 | Cashiers can attach a staff note. The API cleans line endings, trims whitespace, and checks length and control characters. | [validation](../validation.mjs), [orders](../orders.mjs) | Register adjustments |
| 6 | Cash tender enforces an upper limit in addition to checking that the amount covers the sale. Cash change reflects the final discounted and tipped total. | [orders](../orders.mjs) | Cashier checkout, register adjustments |
| 7 | The saved receipt retains the applied adjustment amounts, note, tender, store, and signed menu version for later reads. | [orders](../orders.mjs) | Register adjustments, restart |
| 8 | Sale retries include normalized adjustments in their request identity. Earlier unadjusted receipts can still be read and retried with their original idempotency keys. | [orders](../orders.mjs) | Register adjustments, older order receipts |
| 9 | A terminal can load its own recent receipts from the ledger, with a bounded result limit. | [server](../server.mjs), [orders](../orders.mjs) | Register adjustments |
| 10 | Registers and operations can query availability overrides for a specific store. Other storefronts keep their own stock. | [inventory](../inventory.mjs), [store](../store.mjs) | Store stock |
| 11 | Staff can mark an item out of stock even when it normally has unlimited availability. | [inventory](../inventory.mjs) | Store stock |
| 12 | Staff can set a finite count or reset an item to unlimited availability. | [inventory](../inventory.mjs) | Store stock |
| 13 | Consuming the last counted unit makes the item unavailable automatically. | [inventory](../inventory.mjs) | Store stock |
| 14 | Quotes flag unavailable items before tender and identify the SKU, store, and remaining count. | [inventory](../inventory.mjs), [server](../server.mjs) | Store stock |
| 15 | Stock validation counts the same SKU across differently customized lines. | [inventory](../inventory.mjs) | Store stock |
| 16 | Checkout commits stock consumption and the receipt in one transaction. Retrying a successful sale leaves stock untouched. | [orders](../orders.mjs), [inventory](../inventory.mjs) | Store stock |
| 17 | Connected views receive an inventory event when staff changes an override or a sale consumes counted stock. | [inventory](../inventory.mjs), [server](../server.mjs), [orders](../orders.mjs) | Store stock |
| 18 | The audit trail identifies manual stock changes and stock exhaustion by store and item. | [inventory](../inventory.mjs), [store](../store.mjs) | Store stock |
| 19 | Operations can record a full demo refund against the original charged amount. The original tender and receipt remain available alongside the refund record. | [orders](../orders.mjs), [store](../store.mjs) | Full demo refunds |
| 20 | The refund ledger enforces one refund per sale and a unique operation key. An exact retry returns the original refund. | [orders](../orders.mjs), [store](../store.mjs) | Full demo refunds, restart |
| 21 | Refunds require a bounded staff reason and record an audit event with the order number, store, and amount. | [orders](../orders.mjs), [validation](../validation.mjs) | Full demo refunds |
| 22 | Refunded orders move out of active kitchen and pickup work, show separately in order counts, and cannot advance in the kitchen. | [orders](../orders.mjs) | Full demo refunds |
| 23 | Sales reports filter by storefront and inclusive UTC dates. A later refund counts in the period when it was posted. | [reports](../reports.mjs) | UTC sales, later refund |
| 24 | Sales reports reconcile gross item sales, discounts, taxes, tips, charges, refunds, and net receipts by storefront, day, and overall. | [reports](../reports.mjs) | UTC sales |
| 25 | The same filtered report can be downloaded as CSV for reconciliation. The export contains aggregate amounts and excludes staff notes and refund reasons. | [server](../server.mjs), [reports](../reports.mjs) | UTC sales and CSV |

Run `npm test` for the [integration suite](../test/integration.mjs). It starts an isolated server and SQLite database, exercises real HTTP requests, and verifies persisted values after killing and restarting the process. The refund ledger represents simulated money movement. A refund retains the recorded stock deduction, so staff can decide whether a separate stock adjustment is appropriate.

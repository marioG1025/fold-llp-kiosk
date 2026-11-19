# Counter hardware references

Square's second-generation Register drawing marks the seller panel at **13.25 inches** and the customer panel at **7 inches** diagonally. Its cited technical specifications describe two screens and provide physical dimensions. They do not publish the screens' native pixel resolutions. [Square's technical specifications](https://squareup.com/us/en/hardware/register/specs) · [Square's dimension drawing](https://images.ctfassets.net/2d5q1td6cyxq/3dPFSSsfmJGODzz4WJwm10/f362c5a4bd33e80b22d34f57641786e8/PD08114_USEN_Base_Register_dimensions.png)

FOLD uses the documented original Clover Station Duo display pair as a comparable reference.

| Test profile | Dimensions | Basis |
|---|---:|---|
| Seller | 1920 × 1080 | Clover Station Duo 14-inch merchant screen and Elo's 15.6-inch I-Series 4 |
| Customer and compact 16:10 register | 1280 × 800 | Clover Station Duo 7-inch guest screen and Clover Mini 3 |
| Compact counter | 1366 × 768 | Additional FOLD browser viewport to check screen height and overflow |
| Scaled Full HD | 1536 × 864 | FOLD approximation of 1920 × 1080 at a 125% scale factor |

[Clover developer hardware specifications](https://docs.clover.com/dev/docs/clover-devices-tech-specs) · [Elo technical support specifications](https://elosupport.elotouch.com/hc/en-us/articles/31351534060311-Where-can-I-find-information-on-the-I-Series-4-for-Android-15-inch-AIO)

Hardware pixels measure the panel. Terminal Lab sets **CSS pixels**, which vary with browser zoom, OS scaling and device density. The preview preserves the embedded page's logical viewport and then scales its appearance to fit the surrounding browser. **Measure now** checks page overflow and the designated tap targets. FOLD uses 44 × 44 CSS pixels for primary controls based on W3C's enhanced target-size guidance. These browser checks do not certify accessibility or installation on Square or Clover devices. [W3C target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)

Square's restaurant workflows provide the operational reference for open tickets, routing to kitchen screens, item availability, discounts, refunds and reconciliation. FOLD implements its own interface and a simulated tender ledger. [Square restaurant feature reference](https://squareup.com/us/en/point-of-sale/restaurants/pricing)

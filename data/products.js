// Demo catalog - Olight-style tactical flashlight store.
// Prices live server-side only; client sends product ids + quantities and the
// server computes all totals (never trust amounts coming from the browser).

const products = [
  {
    id: "warrior-x4",
    name: "Warrior X4 Tactical",
    tagline: "2,600-lumen tactical thrower with 630 m beam",
    price: 129.95,
    badge: "Best Seller",
    color1: "#1c2733",
    color2: "#3da9fc",
    description:
      "Flagship rechargeable tactical flashlight with dual-stage tail switch, magnetic charging and IPX8 waterproofing. Built for duty, search and outdoor use.",
    specs: ["2,600 lumens", "630 m throw", "5000mAh 21700 battery", "MCC3 magnetic charging", "IPX8 / 1.5 m impact"]
  },
  {
    id: "baton-4-pro",
    name: "Baton 4 Pro EDC",
    tagline: "Pocket powerhouse - 1,800 lumens in 10 cm",
    price: 99.99,
    badge: "New",
    color1: "#232323",
    color2: "#7fdb6a",
    description:
      "The everyday-carry classic. Side switch with battery indicator, shake-to-wake display and wireless charging case that triples runtime on the go.",
    specs: ["1,800 lumens", "165 m throw", "Charging case included", "59 g body", "IPX8"]
  },
  {
    id: "seeker-5",
    name: "Seeker 5 Search Light",
    tagline: "4,400 lumens of wide flood for search & rescue",
    price: 149.99,
    badge: "",
    color1: "#26221c",
    color2: "#ffb648",
    description:
      "High-output search light with rotary knob brightness control, proximity sensor and dual LED + laser ranging. The choice for professionals.",
    specs: ["4,400 lumens", "205 m throw", "Rotary dimming knob", "Proximity sensor", "USB-C fast charge"]
  },
  {
    id: "arkfeld-ultra",
    name: "Arkfeld Ultra Flat",
    tagline: "Flat-body EDC with white light, green laser & UV",
    price: 79.99,
    badge: "",
    color1: "#1f2430",
    color2: "#c084fc",
    description:
      "Three light sources in one flat, shirt-pocket body: 1,400-lumen white light, 520 nm green laser pointer and 365 nm UV for inspection.",
    specs: ["1,400 lumens", "White + laser + UV", "Center button + selector", "Magnetic charging", "2-way clip"]
  },
  {
    id: "javelot-turbo",
    name: "Javelot Turbo LRT",
    tagline: "1,300 m of throw - the long-range king",
    price: 169.95,
    badge: "Pro",
    color1: "#11202a",
    color2: "#41d6c3",
    description:
      "Long-range thrower with a focused hot spot reaching 1.3 km. Dual switches, lockout mode and holster included for field deployment.",
    specs: ["1,300 m throw", "2,150 lumens", "Dual tail/side switch", "Holster included", "IPX8"]
  },
  {
    id: "perun-3",
    name: "Perun 3 Headlamp",
    tagline: "3,000-lumen right-angle light & headlamp in one",
    price: 89.95,
    badge: "",
    color1: "#202618",
    color2: "#e8e337",
    description:
      "Right-angle work light that clips to cap brims or rides the included headband. Gesture sensor control for hands-free on/off with gloves.",
    specs: ["3,000 lumens", "Wave-to-control sensor", "Headband included", "Magnetic tailcap", "IPX8"]
  }
];

function getProduct(id) {
  return products.find((p) => p.id === id);
}

module.exports = { products, getProduct };

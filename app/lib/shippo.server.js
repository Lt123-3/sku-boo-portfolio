// app/lib/shippo.server.js
//
// Server-side Shippo rate lookup — ported from the Chrome extension's
// lib/shippo.ts so esp-server.js can compute rates directly instead of
// depending on the extension to do it and report back.

const SHIPPO_URL = "https://api.goshippo.com/shipments/";

export async function getUspsRates(apiKey, from, to, parcel) {
  const res = await fetch(SHIPPO_URL, {
    method: "POST",
    headers: {
      Authorization: `ShippoToken ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      address_from: { country: "US", ...from },
      address_to: { country: "US", ...to },
      parcels: [
        {
          // toFixed(2) — Shippo rejects more than 4 decimal places, and a
          // raw String() of a float can easily produce 5+ (e.g. an ESP32
          // weight entry converts fractional ounces via /16, and dividing a
          // 1-decimal value by 16 almost always yields 5 decimal digits).
          length: parcel.length.toFixed(2),
          width: parcel.width.toFixed(2),
          height: parcel.height.toFixed(2),
          distance_unit: "in",
          weight: parcel.weightLb.toFixed(2),
          mass_unit: "lb",
        },
      ],
      async: false,
    }),
  });

  if (!res.ok) {
    throw new Error(`Shippo HTTP ${res.status}: ${await res.text()}`);
  }

  const shipment = await res.json();
  if (shipment.status !== "SUCCESS") {
    throw new Error(`Rate request failed: ${JSON.stringify(shipment.messages ?? shipment)}`);
  }

  return (shipment.rates ?? [])
    .filter((r) => r.provider === "USPS")
    .map((r) => ({
      serviceLevel: r.servicelevel.name,
      amount: Number(r.amount),
      currency: r.currency,
      estimatedDays: r.estimated_days,
    }))
    .sort((a, b) => a.amount - b.amount);
}

// Fails loudly and specifically if misconfigured, rather than silently
// sending Shippo a shipment with blank address fields and getting back a
// confusing Shippo-side validation error instead.
export function getShipFromAddress() {
  const { SHIP_FROM_STREET1, SHIP_FROM_CITY, SHIP_FROM_STATE, SHIP_FROM_ZIP } = process.env;
  if (!SHIP_FROM_STREET1 || !SHIP_FROM_CITY || !SHIP_FROM_STATE || !SHIP_FROM_ZIP) {
    throw new Error("Server misconfigured: SHIP_FROM_* env vars not fully set");
  }
  return {
    name: process.env.SHIP_FROM_NAME || "Shipping Desk",
    street1: SHIP_FROM_STREET1,
    city: SHIP_FROM_CITY,
    state: SHIP_FROM_STATE,
    zip: SHIP_FROM_ZIP,
  };
}

import { useFetcher } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { useAppBridge } from "@shopify/app-bridge-react";

// ── BACKEND ──────────────────────────────────────────────────────────────────

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // Step 1: Get shop ID and current SKU metafield at the same time
  const metafieldQuery = await admin.graphql(
    `#graphql
    query getShopAndSku {
      shop {
        id
        metafield(namespace: "inventory", key: "next_sku") {
          id
          value
        }
      }
    }`
  );

  const metafieldData = await metafieldQuery.json();
  const shop = metafieldData.data.shop;
  const shopId = shop.id;
  const currentSku = shop.metafield ? parseInt(shop.metafield.value) : 1000;
  const skuString = String(currentSku).padStart(6, "0");
  const titleString = `${currentSku} - `;

  console.log("Shop ID:", shopId);
  console.log("Current SKU:", currentSku);

  // Step 2: Create the product
  const productResponse = await admin.graphql(
    `#graphql
    mutation productSet($input: ProductSetInput!) {
      productSet(input: $input) {
        product {
          id
          title
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        input: {
          title: titleString,
          handle: `item-${skuString}`,
          status: "DRAFT",
          vendor: "0",
          productOptions: [
            { name: "Title", values: [{ name: "Default Title" }] }
          ],
          variants: [
            {
              sku: skuString,
              price: "19.99",
              optionValues: [
                { optionName: "Title", name: "Default Title" }
              ],
            },
          ],
        },
      },
    }
  );

  const productData = await productResponse.json();
  const userErrors = productData.data.productSet.userErrors;

  if (userErrors.length > 0) {
    console.error("Product errors:", userErrors);
    return { error: userErrors };
  }

  const product = productData.data.productSet.product;

  // Step 3: Increment the SKU counter using the real shop GID
  const metafieldsResponse = await admin.graphql(
    `#graphql
    mutation setNextSku($metafields: [MetafieldsSetInput!]!) {
      metafieldsSet(metafields: $metafields) {
        metafields {
          id
          value
        }
        userErrors {
          field
          message
        }
      }
    }`,
    {
      variables: {
        metafields: [
          {
            namespace: "inventory",
            key: "next_sku",
            ownerId: shopId,
            type: "number_integer",
            value: String(currentSku + 1),
          },
        ],
      },
    }
  );

  const metafieldsData = await metafieldsResponse.json();
  console.log("Metafield result:", JSON.stringify(metafieldsData.data.metafieldsSet));

  return { sku: skuString, productId: product.id };
};

// ── FRONTEND ─────────────────────────────────────────────────────────────────

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  const generateSku = () => fetcher.submit({}, { method: "POST" });

  return (
    <s-page heading="SKU Boo">
      <s-section heading="SKU Generator">
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={generateSku}
            {...(isLoading ? { loading: true } : {})}
          >
            Generate Next SKU
          </s-button>
          {fetcher.data?.productId && (
            <s-button
              onClick={() => {
                shopify.intents.invoke?.("edit:shopify/Product", {
                  value: fetcher.data?.productId,
                });
              }}
              variant="tertiary"
            >
              Edit Product
            </s-button>
          )}
        </s-stack>

        {fetcher.data?.sku && (
          <s-section heading="Success">
            <s-paragraph>
              Created product with SKU: {fetcher.data.sku}
            </s-paragraph>
          </s-section>
        )}
      </s-section>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
// prisma/seed.js

import { PrismaClient } from "@prisma/client"

const prisma = new PrismaClient()

async function main() {
  console.log("Seeding database...")

  // --- Create your first admin access key ---
  // Change shopId and userId to your real values before running
  const existing = await prisma.accessKey.findUnique({
    where: {
      shopId_userId: {
        shopId: "YOUR_SHOP_ID",     // your work store ID
        userId: "YOUR_ADMIN_CODE",  // your personal 4-digit warehouse code — change this
      }
    }
  })

  if (existing) {
    console.log("Admin access key already exists — skipping.")
  } else {
    await prisma.accessKey.create({
      data: {
        shopId:  "YOUR_SHOP_ID",     // your work store ID
        userId:  "YOUR_ADMIN_CODE",  // your personal 4-digit warehouse code — change this
        role:    "admin",
        active:  true,
      }
    })
    console.log("Admin access key created successfully.")
  }

  console.log("Done.")
}

main()
  .catch((e) => {
    console.error("Seed failed:", e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
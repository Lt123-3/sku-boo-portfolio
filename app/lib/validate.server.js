// app/lib/validate.server.js

import { SKU_STATUS, ACCESS_ROLES, SKU_PROBLEMS } from "../Config.js"

export function validateSkuStatus(value) {
  const valid = Object.values(SKU_STATUS)
  if (!valid.includes(value)) {
    throw new Error(`Invalid SKU status: "${value}". Must be one of: ${valid.join(", ")}`)
  }
  return value
}

export function validateRole(value) {
  const valid = Object.values(ACCESS_ROLES)
  if (!valid.includes(value)) {
    throw new Error(`Invalid role: "${value}". Must be one of: ${valid.join(", ")}`)
  }
  return value
}

export function validateProblems(arr) {
  const valid = Object.values(SKU_PROBLEMS)
  for (const p of arr) {
    if (!valid.includes(p)) {
      throw new Error(`Invalid problem tag: "${p}". Must be one of: ${valid.join(", ")}`)
    }
  }
  return arr
}
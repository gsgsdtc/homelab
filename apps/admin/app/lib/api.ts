"use client";

import { AdminApiClient } from "@homelab/views";

export const api = new AdminApiClient({
  baseUrl: process.env.NEXT_PUBLIC_ADMIN_API_BASE_URL ?? "/api/backend"
});

/** Nonsecret responses copied verbatim from offline actual authority HTTP handlers. No sibling imports. */
// Capture SHA256 9c34a0863f082b3cddf7c113f1c586c460c71413358fa66843757cfeacf28520.
// Authority6b1b943; later topups-v2.ts→topupsV2.ts keeps module bytes and wire behavior identical.
export const topupAuthorityRecords = [
  {
    "name": "created",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "initial@example.com",
      "packId": "p25"
    },
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-topup-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000001001\",\"binding\":{\"claimId\":\"00000000000000000000010012claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000000001\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010012claims\"}"
  },
  {
    "name": "exact-replay",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "initial@example.com",
      "packId": "p25"
    },
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-topup-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000001001\",\"binding\":{\"claimId\":\"00000000000000000000010012claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000000001\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010012claims\"}"
  },
  {
    "name": "pending-status",
    "method": "GET",
    "path": "/v1/claims/00000000000000000000010012claims",
    "request": null,
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-claim-status-v1\",\"claimId\":\"00000000000000000000010012claims\",\"state\":\"pending\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"balance\":{\"credits\":3000,\"microUsd\":30000000,\"usd\":\"30.00\"}}"
  },
  {
    "name": "changed-request",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "changed@example.com",
      "packId": "p25"
    },
    "status": 409,
    "rawResponse": "{\"error\":\"conflict\"}"
  },
  {
    "name": "wrong-device-token",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "initial@example.com",
      "packId": "p25"
    },
    "status": 401,
    "rawResponse": "{\"error\":\"unauthorized\"}"
  },
  {
    "name": "expired-replay",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "initial@example.com",
      "packId": "p25"
    },
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-topup-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000001001\",\"binding\":{\"claimId\":\"00000000000000000000010012claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000000001\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010012claims\"}"
  },
  {
    "name": "expired-status",
    "method": "GET",
    "path": "/v1/claims/00000000000000000000010012claims",
    "request": null,
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-claim-status-v1\",\"claimId\":\"00000000000000000000010012claims\",\"state\":\"expired\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"balance\":{\"credits\":3000,\"microUsd\":30000000,\"usd\":\"30.00\"}}"
  },
  {
    "name": "paid-past-expiry-replay",
    "method": "POST",
    "path": "/v2/topups",
    "request": {
      "schemaVersion": "hraness-credits-topup-create-v2",
      "creationId": "00000000-0000-4000-8000-000000001001",
      "product": "peopleblade",
      "device": {
        "id": "00000000-0000-4000-8000-000000000001",
        "label": "original"
      },
      "email": "initial@example.com",
      "packId": "p25"
    },
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-topup-created-v2\",\"creationId\":\"00000000-0000-4000-8000-000000001001\",\"binding\":{\"claimId\":\"00000000000000000000010012claims\",\"productId\":\"peopleblade\",\"deviceId\":\"00000000-0000-4000-8000-000000000001\"},\"createdAt\":\"2026-09-16T12:00:00.000Z\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"payUrl\":\"http://localhost:3000/t/00000000000000000000010012claims\"}"
  },
  {
    "name": "paid-status",
    "method": "GET",
    "path": "/v1/claims/00000000000000000000010012claims",
    "request": null,
    "status": 200,
    "rawResponse": "{\"schemaVersion\":\"hraness-credits-claim-status-v1\",\"claimId\":\"00000000000000000000010012claims\",\"state\":\"paid\",\"expiresAt\":\"2026-09-17T12:00:00.000Z\",\"paidAt\":\"2026-09-16T12:00:00.000Z\",\"balance\":{\"credits\":5650,\"microUsd\":56500000,\"usd\":\"56.50\"}}"
  }
] as const;
export const topupAuthoritySource = [
  {
    "path": "support/topup-v2-transport.ts",
    "bytes": 5381,
    "sha256": "c7751acfe0d80be4f6aa24bc5f4bf515b67ddf3b95c8c205b405ce1fe8b508af"
  },
  {
    "path": "convex/topups-v2.ts",
    "bytes": 7265,
    "sha256": "62d5335e10b026b96490e96b6e195b562d1eceb1e0171f7511ef489247f3de0e"
  },
  {
    "path": "convex/http.ts",
    "bytes": 35553,
    "sha256": "d80daf76b65dac31fe74502ac79477a2a01b3e8648cce90c2ddf96848da7f0f1"
  },
  {
    "path": "convex/subjects.ts",
    "bytes": 4302,
    "sha256": "161293292cea20637dd2ad6e479d644dc3c1eee00dc5a9bccf3fee68ee8fa3e1"
  },
  {
    "path": "convex/claims.ts",
    "bytes": 33651,
    "sha256": "6a2201d90ebdcc0d85cceb169d0ab6bc112bb394a0e28b0f3fd76dca031e9834"
  },
  {
    "path": "convex/model.ts",
    "bytes": 4998,
    "sha256": "0be2d44e9931ce497e3fd9540e21f439d792843a18da04099ec843babdd0ffe8"
  },
  {
    "path": "convex/schema.ts",
    "bytes": 6752,
    "sha256": "2a0b2412f2110a9824922548114ef3f83a1bc8db5d41cd79be8112fb54075958"
  }
] as const;

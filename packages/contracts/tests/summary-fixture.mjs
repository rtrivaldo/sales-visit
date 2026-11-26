export const sampleSummary = (role = "sales_force") => ({
  role,
  readOnly: false,
  name: "Akun sintetis",
  salesForceId: role === "sales_force" ? "SF001" : null,
  period: {
    month: 3,
    year: 2027,
    today: "2027-03-15",
    timeZone: "Asia/Jakarta",
  },
  assignedOutlets: 4,
  salesForce: 1,
  users:
    role === "admin"
      ? { admin: 2, supervisor: 4, sales_force: 14, pending: 3 }
      : null,
  today: { scheduled: 8, completed: 5, remaining: 3, percentage: 62.5 },
  month: {
    visits: 24,
    outlets: 18,
    totalPurchase: 24850000,
    knownPurchaseReports: 24,
    missingPurchaseReports: 0,
  },
  activity: { cvm: 15, voice: 12, digital: 17, unknown: 0 },
  stock: { today: 5, month: 24 },
  recentVisits: [],
  recentStock: [],
});

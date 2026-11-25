export type VisitFilters = {
  q: string;
  channel: string;
  member: string;
  outlet: string;
  stock: string;
  date: string;
  offset: string;
  reportingWeek: string;
  reportingMonth: string;
  reportingYear: string;
};

export function validateVisitSearch(
  search: Partial<VisitFilters>
): VisitFilters {
  const text = (key: keyof VisitFilters) =>
    typeof search[key] === "string" ? search[key] : "";
  return {
    q: text("q").slice(0, 200),
    reportingWeek: /^[1-4]$/.test(text("reportingWeek"))
      ? text("reportingWeek")
      : "",
    reportingMonth: /^(?:[1-9]|1[0-2])$/.test(text("reportingMonth"))
      ? text("reportingMonth")
      : "",
    reportingYear: /^[1-9][0-9]{3}$/.test(text("reportingYear"))
      ? text("reportingYear")
      : "",
    member: text("member"),
    outlet: text("outlet"),
    channel: ["web", "telegram"].includes(text("channel"))
      ? text("channel")
      : "",
    stock: ["with", "without"].includes(text("stock")) ? text("stock") : "",
    date: /^\d{4}-\d{2}-\d{2}$/.test(text("date")) ? text("date") : "",
    offset:
      /^\d{1,6}$/.test(text("offset")) && Number(text("offset")) <= 100000
        ? text("offset")
        : "",
  };
}

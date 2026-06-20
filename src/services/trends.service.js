/**
 * Mock dataset — publication count and citation count per year.
 * Sorted ascending by year.
 *
 * @type {Array<{ year: string; articles: number; citations: number }>}
 */
const MOCK_TREND_DATA = [
  { year: '2021', articles: 12000, citations: 85000 },
  { year: '2022', articles: 15000, citations: 110000 },
  { year: '2023', articles: 18500, citations: 142000 },
  { year: '2024', articles: 22000, citations: 190000 },
  { year: '2025', articles: 28000, citations: 250000 },
  { year: '2026', articles: 32950, citations: 310000 },
];

/**
 * Build the trend response payload from raw year-level records.
 *
 * Guarantees:
 *  - timeline is sorted ascending
 *  - every series has the same length as timeline
 *  - no null / undefined values (missing → 0)
 *
 * @param {Array<{ year: string; articles: number; citations: number }>} records
 * @returns {{ timeline: string[]; series: Array<{ name: string; data: number[] }> }}
 */
function buildTrendPayload(records) {
  if (!records || records.length === 0) {
    return { timeline: [], series: [] };
  }

  // Sort ascending by year
  const sorted = [...records].sort((a, b) => a.year.localeCompare(b.year));

  const timeline = sorted.map((r) => r.year);

  const series = [
    {
      name: 'Articles',
      data: sorted.map((r) => (typeof r.articles === 'number' ? r.articles : 0)),
    },
    {
      name: 'Citations',
      data: sorted.map((r) => (typeof r.citations === 'number' ? r.citations : 0)),
    },
  ];

  return { timeline, series };
}

export async function getPublicationTrends() {
  // Phase 1: return mock data.
  // In a future phase this function will query the database instead.
  return buildTrendPayload(MOCK_TREND_DATA);
}

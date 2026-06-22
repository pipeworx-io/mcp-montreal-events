interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Montréal Events MCP.
 *
 * Public events across the city of Montréal (Canada) from the city's open-data
 * portal (donnees.montreal.ca, "evenements-publics" CKAN datastore). Keyless,
 * ~6,000 events. Filter by keyword, borough (arrondissement) and date window.
 * Content is in French (Montréal source).
 */


const SQL_URL = 'https://donnees.montreal.ca/api/3/action/datastore_search_sql';
const RESOURCE_ID = '6decf611-6f11-4f34-bb36-324d804c9bad';
const UA = 'pipeworx-mcp-montreal-events/1.0 (+https://pipeworx.io)';
const MAX_LIMIT = 50;

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Find upcoming public events in Montréal, Canada. Filter by keyword, borough (arrondissement, e.g. "Ville-Marie", "Le Plateau-Mont-Royal") and date window. Returns events sorted by start date. Content is in French.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword over title and description, e.g. "musique", "festival", "famille".' },
        borough: { type: 'string', description: 'Filter by arrondissement, e.g. "Ville-Marie", "Le Plateau-Mont-Royal", "Rosemont".' },
        from: { type: 'string', description: 'Include events ending on/after this date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'Include events starting on/before this date YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max events (1-${MAX_LIMIT}, default 20).` },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const where: string[] = [`date_fin >= '${from}'`];
  if (to) where.push(`date_debut <= '${to}'`);
  if (typeof args.borough === 'string' && args.borough.trim()) where.push(`arrondissement ILIKE '%${sql(args.borough)}%'`);
  if (typeof args.query === 'string' && args.query.trim()) {
    const q = sql(args.query);
    where.push(`(titre ILIKE '%${q}%' OR description ILIKE '%${q}%')`);
  }
  const clause = where.join(' AND ');
  const limit = clamp(numArg(args.limit, 20), 1, MAX_LIMIT);
  const offset = Math.max(0, numArg(args.offset, 0));

  const total = await countQuery(clause);
  const rows = (await runSql(
    `SELECT _id,titre,url_fiche,description,date_debut,date_fin,type_evenement,public_cible,emplacement,inscription,cout,arrondissement,adresse_principale,code_postal,lat,long FROM "${RESOURCE_ID}" WHERE ${clause} ORDER BY date_debut ASC LIMIT ${limit} OFFSET ${offset}`,
  )) as MtlEvent[];

  return {
    city: 'Montréal',
    country: 'Canada',
    source: 'donnees.montreal.ca',
    date_from: from,
    date_to: to || null,
    total_matching: total,
    count: rows.length,
    events: rows.map(normalize),
  };
}

async function countQuery(clause: string): Promise<number> {
  try {
    const rows = (await runSql(`SELECT COUNT(*) AS n FROM "${RESOURCE_ID}" WHERE ${clause}`)) as { n?: string | number }[];
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

async function runSql(sqlText: string): Promise<unknown[]> {
  const res = await fetch(`${SQL_URL}?sql=${encodeURIComponent(sqlText)}`, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { records?: unknown[] }; error?: { message?: string } };
  if (!res.ok || body.success === false) throw new Error(`Montréal: ${body.error?.message || `HTTP ${res.status}`}`);
  return body.result?.records ?? [];
}

interface MtlEvent {
  _id?: number;
  titre?: string;
  url_fiche?: string;
  description?: string;
  date_debut?: string;
  date_fin?: string;
  type_evenement?: string;
  public_cible?: string;
  emplacement?: string;
  inscription?: string;
  cout?: string;
  arrondissement?: string;
  adresse_principale?: string;
  code_postal?: string;
  lat?: string | number;
  long?: string | number;
}

function normalize(e: MtlEvent): Record<string, unknown> {
  const cost = (e.cout || '').trim();
  const reg = (e.inscription || '').trim();
  return {
    id: e._id,
    title: e.titre,
    url: e.url_fiche,
    summary: e.description ? e.description.replace(/\s+/g, ' ').trim().slice(0, 600) : undefined,
    date_start: e.date_debut || undefined,
    date_end: e.date_fin && e.date_fin !== e.date_debut ? e.date_fin : undefined,
    type: e.type_evenement || undefined,
    audience: e.public_cible || undefined,
    is_free: /gratuit|entrée libre|libre/i.test(`${cost} ${reg}`),
    cost: cost || undefined,
    registration: reg || undefined,
    borough: e.arrondissement || undefined,
    venue: {
      location: e.emplacement || undefined,
      address: [e.adresse_principale, e.code_postal].filter((p) => p && String(p).trim()).join(', ') || undefined,
      latitude: numOrUndef(e.lat),
      longitude: numOrUndef(e.long),
    },
  };
}

/** Escape single quotes for the read-only datastore SQL (defence-in-depth; endpoint is SELECT-only). */
function sql(v: string): string {
  return v.trim().replace(/'/g, "''").replace(/[;\\]/g, '').slice(0, 80);
}
function numOrUndef(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n !== 0 ? n : undefined;
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() - 4 * 3600 * 1000); // approx Montréal (EDT)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;

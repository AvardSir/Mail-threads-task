/**
 * Веха 8: структурные тесты инфраструктурных артефактов.
 *
 * Expected Red (до Запроса 3):
 *   A1–A7, B1–B3 — Dockerfile / .dockerignore отсутствуют.
 *   C1–C11, D1–D2 — в docker-compose.yml только provider.
 *   E1–E2 — scripts/entrypoint.sh отсутствует.
 *   F1 — describe.skip, не считается.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const ROOT = path.resolve(__dirname, '..');
const DOCKERFILE = path.join(ROOT, 'Dockerfile');
const DOCKERIGNORE = path.join(ROOT, '.dockerignore');
const COMPOSE = path.join(ROOT, 'docker-compose.yml');
const ENTRYPOINT = path.join(ROOT, 'scripts', 'entrypoint.sh');

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const exists = (p: string): boolean => fs.existsSync(p);

// ---------- Helpers для compose ----------
let composeCache: any = null;
const compose = (): any => {
  if (composeCache === null) composeCache = yaml.load(read(COMPOSE));
  return composeCache;
};

/** Приводит service.environment к плоскому объекту { KEY: "value" }. */
const envObj = (svc: any): Record<string, string> => {
  const e = svc?.environment;
  if (!e) return {};
  if (Array.isArray(e)) {
    return Object.fromEntries(
      e.map((x: string) => {
        const i = x.indexOf('=');
        return i === -1 ? [x, ''] : [x.slice(0, i), x.slice(i + 1)];
      }),
    );
  }
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v ?? '')]));
};

/** Приводит service.env_file к массиву строк-путей. */
const envFiles = (svc: any): string[] => {
  const ef = svc?.env_file;
  if (!ef) return [];
  if (typeof ef === 'string') return [ef];
  if (Array.isArray(ef)) return ef.map((x: any) => (typeof x === 'string' ? x : x.path));
  return [ef.path];
};

// ============================================================
// A. Dockerfile
// ============================================================
describe('Dockerfile (Веха 8)', () => {
  it('A1: exists and has at least 2 FROM ... AS stages', () => {
    expect(exists(DOCKERFILE)).toBe(true);
    const src = read(DOCKERFILE);
    const stages = src.match(/^FROM\s+\S+\s+AS\s+\S+/gim) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it('A2: includes prisma generate', () => {
    expect(read(DOCKERFILE)).toMatch(/prisma\s+generate/);
  });

  it('A3: final stage runs as non-root (USER not root/0)', () => {
    const src = read(DOCKERFILE);
    const users = [...src.matchAll(/^\s*USER\s+(\S+)/gim)].map((m) => m[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users[users.length - 1]).not.toMatch(/^(root|0)$/i);
  });

  it('A4: runtime stage installs prod-only deps (npm ci --omit=dev)', () => {
    expect(read(DOCKERFILE)).toMatch(/npm\s+ci\s+--omit=dev/);
  });

  it('A5: COPY package*.json before COPY . .', () => {
    const src = read(DOCKERFILE);
    const copyPkg = src.search(/COPY\s+package\*?\.json/);
    const copyAll = src.search(/^\s*COPY\s+\.\s+\./m);
    expect(copyPkg).toBeGreaterThanOrEqual(0);
    expect(copyAll).toBeGreaterThanOrEqual(0);
    expect(copyPkg).toBeLessThan(copyAll);
  });

  it('A6: no hardcoded CMD in image (commands come from compose)', () => {
    expect(read(DOCKERFILE)).not.toMatch(/^\s*CMD\s/m);
  });

  it('A7: ENTRYPOINT delegates to scripts/entrypoint.sh', () => {
    expect(read(DOCKERFILE)).toMatch(/ENTRYPOINT\s+\[.*entrypoint\.sh.*\]/);
  });
});

// ============================================================
// B. .dockerignore
// ============================================================
describe('.dockerignore (Веха 8)', () => {
  it('B1: exists', () => {
    expect(exists(DOCKERIGNORE)).toBe(true);
  });

  it('B2: excludes node_modules, dist, coverage, .git, .env, out', () => {
    const src = read(DOCKERIGNORE);
    for (const entry of ['node_modules', 'dist', 'coverage', '.git', '.env', 'out']) {
      expect(src).toMatch(new RegExp(`^${entry.replace('.', '\\.')}\\s*$`, 'm'));
    }
  });

  it('B3: does NOT exclude prisma/ (migrations needed inside image)', () => {
    expect(read(DOCKERIGNORE)).not.toMatch(/^prisma\/?\s*$/m);
  });
});

// ============================================================
// C. docker-compose.yml
// ============================================================
describe('docker-compose.yml (Веха 8)', () => {
  it('C1: is valid YAML', () => {
    expect(() => compose()).not.toThrow();
    expect(compose()).toBeTruthy();
  });

  it('C2: has services provider, db, worker, exporter', () => {
    const services = compose().services ?? {};
    for (const name of ['provider', 'db', 'worker', 'exporter']) {
      expect(services).toHaveProperty(name);
    }
  });

  it('C3: db is postgres:15 with pg_isready healthcheck and named volume', () => {
    const db = compose().services.db;
    expect(String(db.image)).toMatch(/^postgres:15/);
    const testStr = JSON.stringify(db.healthcheck?.test ?? '');
    expect(testStr).toMatch(/pg_isready/);
    expect(Array.isArray(db.volumes)).toBe(true);
    expect(db.volumes.length).toBeGreaterThan(0);
  });

  it('C4: db does NOT publish ports to host', () => {
    expect(compose().services.db.ports).toBeUndefined();
  });

  it('C5: worker depends_on db AND provider, both service_healthy, restart "no"', () => {
    const worker = compose().services.worker;
    expect(worker.depends_on?.db?.condition).toBe('service_healthy');
    expect(worker.depends_on?.provider?.condition).toBe('service_healthy');
    expect(worker.restart).toBe('no');
  });

  it('C6: exporter depends_on db: service_healthy, restart "no", ./out bind-mount', () => {
    const exporter = compose().services.exporter;
    expect(exporter.depends_on?.db?.condition).toBe('service_healthy');
    expect(exporter.restart).toBe('no');
    const vols = (exporter.volumes ?? []) as string[];
    expect(vols.some((v) => v.startsWith('./out:'))).toBe(true);
  });

  it('C7: worker and exporter share one build/image (no double build)', () => {
    const w = compose().services.worker;
    const e = compose().services.exporter;
    const sameBuild =
      w.build && e.build && JSON.stringify(w.build) === JSON.stringify(e.build);
    const sameImage = w.image && w.image === e.image;
    expect(sameBuild || sameImage).toBeTruthy();
  });

  it('C8: worker and exporter declare env_file .env', () => {
    for (const name of ['worker', 'exporter']) {
      const files = envFiles(compose().services[name]);
      expect(files.some((f) => f.includes('.env'))).toBe(true);
    }
  });

  it('C9: worker/exporter override PROVIDER_URL → http://provider:8080', () => {
    for (const name of ['worker', 'exporter']) {
      const env = envObj(compose().services[name]);
      expect(env.PROVIDER_URL).toBe('http://provider:8080');
    }
  });

  it('C10: worker/exporter override DATABASE_URL → db:5432', () => {
    for (const name of ['worker', 'exporter']) {
      const env = envObj(compose().services[name]);
      expect(env.DATABASE_URL).toMatch(/@db:5432\//);
    }
  });

  it('C11: worker/exporter provide all tunables (no NaN in client config)', () => {
    const required = [
      'REQUEST_TIMEOUT',
      'MAX_RETRIES',
      'BASE_DELAY',
      'MAX_DELAY',
      'TOTAL_OPERATION_TIMEOUT',
      'LOG_LEVEL',
    ];
    for (const name of ['worker', 'exporter']) {
      const env = envObj(compose().services[name]);
      for (const key of required) {
        expect(env[key]).toBeDefined();
        expect(env[key]).not.toBe('');
      }
    }
  });
});

// ============================================================
// D. Consistency
// ============================================================
describe('docker-compose.yml consistency', () => {
  it('D1: all depends_on reference existing services', () => {
    const c = compose();
    const services = Object.keys(c.services ?? {});
    for (const svc of Object.values<any>(c.services ?? {})) {
      for (const d of Object.keys(svc.depends_on ?? {})) {
        expect(services).toContain(d);
      }
    }
  });

  it('D2: named volume for db data is declared at top level', () => {
    const c = compose();
    const dbVols = (c.services.db.volumes ?? []) as string[];
    const named = dbVols
      .map((v) => v.split(':')[0])
      .filter((v) => !v.startsWith('.') && !v.startsWith('/'));
    expect(named.length).toBeGreaterThan(0);
    for (const n of named) expect(c.volumes ?? {}).toHaveProperty(n);
  });
});

// ============================================================
// E. Entrypoint
// ============================================================
describe('scripts/entrypoint.sh (Веха 8)', () => {
  it('E1: exists, runs prisma migrate deploy and exec "$@"', () => {
    expect(exists(ENTRYPOINT)).toBe(true);
    const src = read(ENTRYPOINT);
    expect(src).toMatch(/prisma\s+migrate\s+deploy/);
    expect(src).toMatch(/exec\s+"\$@"/);
  });

  it('E2: Dockerfile copies and wires it as ENTRYPOINT', () => {
    const src = read(DOCKERFILE);
    expect(src).toMatch(/COPY\s+.*entrypoint\.sh/);
    expect(src).toMatch(/ENTRYPOINT\s+\[.*entrypoint\.sh.*\]/);
  });
});

// ============================================================
// F. Smoke (requires docker CLI, skipped by default)
// ============================================================
describe.skip('docker compose config (smoke, requires docker CLI)', () => {
  it('F1: docker compose config exits 0', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execSync } = require('child_process');
    expect(() => execSync('docker compose config --quiet', { stdio: 'pipe' })).not.toThrow();
  });
});
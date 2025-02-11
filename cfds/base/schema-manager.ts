import type { CoreObject } from '../../base/core-types/base.ts';
import { coreValueClone } from '../../base/core-types/clone.ts';
import { assert } from '../../base/error.ts';
import type { Session } from '../../db/session.ts';
import { type GoatDB, itemPathGetRepoId, Repository } from '../../mod.ts';
import {
  kNullSchema,
  kSchemaSession,
  kSchemaUser,
  kSchemaUserStats,
  type Schema,
} from './schema.ts';

/**
 * Denotes the type of the requested operation.
 */
export type AuthOp = 'read' | 'write';

/**
 * A function that implements access control rules for a given repository or
 * group of repositories.
 *
 * Note that this method gets called repeatedly on every access attempt so it
 * must be very efficient.
 *
 * @param db       The main DB instance.
 * @param repoPath Path to the repository being accessed.
 * @param itemKey  The key being accessed.
 * @param session  The session requesting access.
 * @param op       The access type being made.
 *
 * @returns true if access is granted, false otherwise.
 */
export type AuthRule = (
  db: GoatDB,
  repoPath: string,
  itemKey: string,
  session: Session,
  op: AuthOp,
) => boolean;

/**
 * An array of authentication rules for the full DB. The DB scans these rules
 * and will use the first one that matches the repository's path.
 */
export type AuthConfig = {
  rulePath: RegExp | string;
  rule: AuthRule;
}[];

/**
 * The schemaManager acts as a registry of known schemas for a given GoatDB
 * instance. It's initialized when the app starts and stays fixed during its
 * execution.
 *
 * Typically, apps use the `schemaManager.default` instance, but are free to
 * create multiple managers each with different schemas registered.
 */
export class SchemaManager {
  private readonly _schemas: Map<string, Schema[]>;
  private _authRules: AuthConfig;

  /**
   * The default manager. Unless explicitly specified, GoatDB will default to
   * this manager.
   */
  static readonly default: SchemaManager = new this();

  /**
   * Initialize a new schemaManager.
   */
  constructor() {
    this._schemas = new Map();
    this._authRules = [];
    // Builtin schemas
    this.registerSchema(kSchemaSession);
    this.registerSchema(kSchemaUser);
    this.registerSchema(kSchemaUserStats);
  }

  /**
   * Registers a schema with this manager. This is a NOP if the schema had
   * already been registered.
   *
   * @param schema The schema to register.
   */
  registerSchema(schema: Schema): void {
    assert(schema.ns !== null);
    let arr = this._schemas.get(schema.ns);
    if (!arr) {
      arr = [];
      this._schemas.set(schema.ns, arr);
    }
    if (arr.find((s) => s.version === schema.version) === undefined) {
      arr.push(schema);
      arr.sort((s1, s2) => s2.version - s1.version);
    }
  }

  /**
   * Registers an authorization rule with this manager. If not provided, all
   * data is considered public.
   *
   * @param path Path to a repository or a {@link RegExp} instance.
   * @param rule A function responsible for authorizing single items within
   *             repositories that match the given path.
   */
  registerAuthRule(path: RegExp | string, rule: AuthRule): void {
    if (typeof path === 'string') {
      path = itemPathGetRepoId(path);
    }
    for (const { rulePath: p } of this._authRules) {
      assert(
        p === path,
        'Attempting to register multiple rules for the same path',
      );
    }
    this._authRules.push({ rulePath: path, rule });
  }

  /**
   * Find a schema that's been registered with this manager.
   *
   * @param ns      The namespace for the schema.
   * @param version If provided, searches for the specific version. Otherwise
   *                this method will return the latest version for the passed
   *                namespace.
   *
   * @returns A schema or undefined if not found.
   */
  get(ns: string, version?: number): Schema | undefined {
    const arr = this._schemas.get(ns);
    if (!arr) {
      return undefined;
    }
    return version ? arr.find((s) => s.version === version) : arr[0];
  }

  /**
   * Given a data object and its schema, this method performs the upgrade
   * procedure to the target schema.
   *
   * This method will refuse to upgrade to the target schema if a single version
   * is missing. For example, if attempting to upgrade from v1 to v3, but the
   * v2 schema is missing, then the upgrade will be refused.
   *
   * NOTE: You shouldn't use this method directly under normal circumstances.
   * The upgrade procedure will be performed automatically for you when needed.
   *
   * @param data         The data to upgrade.
   * @param dataSchema   The schema of the passed data.
   * @param targetSchema The target schema. If not provided, the latest schema
   *                     for the namespace will be used.
   *
   * @returns An array in the form of [data, schema] with the result. Returns
   *          undefined if the upgrade failed.
   */
  upgrade(
    data: CoreObject,
    dataSchema: Schema,
    targetSchema?: Schema,
  ): [CoreObject, Schema] | undefined {
    if (
      (targetSchema === undefined || targetSchema.ns === null) &&
      dataSchema.ns === null
    ) {
      return [data, kNullSchema];
    }
    assert(
      dataSchema.ns !== null ||
        (targetSchema !== undefined && targetSchema.ns !== null),
    );
    const ns = targetSchema?.ns || dataSchema.ns!;
    const latest = this.get(ns, targetSchema?.version);
    if (!latest || latest.version === dataSchema.version) {
      return [data, dataSchema];
    }

    let currentSchema = dataSchema;
    let upgradedData = coreValueClone(data);
    for (let i = dataSchema.version + 1; i <= latest.version; ++i) {
      const schema = this.get(ns, i);
      if (!schema) {
        return undefined;
      }
      if (schema.upgrade) {
        upgradedData = schema.upgrade(upgradedData, currentSchema);
      }
      currentSchema = schema;
    }
    return [upgradedData, currentSchema];
  }

  /**
   * Encoded a schema to a marker string for storage.
   * @param schema The schema to encode.
   * @returns A string marker for this schema.
   */
  encode(schema: Schema): string {
    if (schema.ns === null) {
      return 'null';
    }
    return `${schema.ns}/${schema.version}`;
  }

  /**
   * Decodes a schema marker to an actual schema.
   * @param str The schema marker produced by a previous call to
   *            `schemaManager.encode`.
   *
   * @returns The registered schema or undefined if no such schema is found.
   */
  decode(str: string /*| Decoder*/): Schema | undefined {
    if (str === 'null') {
      return kNullSchema;
    }
    if (typeof str === 'string') {
      const [ns, ver] = str.split('/');
      return this.get(ns, parseInt(ver));
    }
    // if (str.has('ns') && str.has('version')) {
    //   const ns = str.get<string>('ns')!;
    //   const ver = str.get<number>('version')!;
    //   return this.get(ns, ver);
    // }
    return undefined;
  }

  /**
   * Finds the authorization rule for the provided path.
   *
   * @param inputPath The path to search for.
   * @returns An {@link AuthRule} or undefined.
   */
  authRuleForRepo(
    inputPath: string,
  ): AuthRule | undefined {
    const repoId = itemPathGetRepoId(inputPath);
    // Builtin rules override user-provided ones
    for (const { rulePath, rule } of kBuiltinAuthRules) {
      if (rulePath === repoId) {
        return rule;
      }
    }
    // Look for a user-provided rule
    for (const { rulePath, rule } of this._authRules) {
      if (typeof rulePath === 'string') {
        if (Repository.normalizePath(rulePath) === repoId) {
          return rule;
        }
      } else {
        rulePath.lastIndex = 0;
        if (rulePath.test(inputPath)) {
          return rule;
        }
      }
    }
  }
}

const kBuiltinAuthRules: AuthConfig = [
  {
    rulePath: '/sys/users',
    rule: (_db, _repoPath, itemKey, session, op) => {
      if (session.owner === 'root') {
        return true;
      }
      if (session.owner === itemKey) {
        return true;
      }
      return op === 'read';
    },
  },
  {
    rulePath: '/sys/sessions',
    rule: (_db, _repoPath, _itemKey, session, op) => {
      if (session.owner === 'root') {
        return true;
      }
      return op === 'read';
    },
  },
  {
    rulePath: '/sys/stats',
    rule: (_db, _repoPath, _itemKey, session, op) => {
      return session.owner === 'root';
    },
  },
  // Reserving /sys/* for the system's use
  {
    rulePath: /[/]sys[/]\S*/g,
    rule: (_db, _repoPath, _itemKey, session, _op) => {
      return session.owner === 'root';
    },
  },
] as const;

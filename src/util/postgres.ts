
import { Pool } from 'pg';

export default class PGClient {
  pool: any = null;
  debug: boolean = false;


  public static build(config: any): PGClient {
    try {
      const pGClient = new PGClient();
      const client = new Pool({
        host: config.host,
        port: config.port ? ~~config.port : 5432,
        database: config.database,
        user: config.user,
        password: config.password,
        max: config.max || 20,
        idleTimeoutMillis: config.idleTimeoutMillis || 30000,
        connectionTimeoutMillis: config.connectionTimeoutMillis || 2000,
      });
      pGClient.debug = config.debugMode;
      pGClient.pool = client;
      return pGClient;
    } catch (err: any) {
      console.error("❌ Postgres connection error: ", err.message);
    }
    return null;
  }

  public async query(sql: string, params: any): Promise<any> {
    if (!this.pool) {
      return {}
    }
    if (this.debug) {
      console.log("------------", new Date(), "----------------------------");
      console.log("sql: ", sql);
      console.log("params: ", params);
      console.log("pool.totalCount:", this.pool.totalCount,
        "| pool.idleCount:", this.pool.idleCount,
        "| pool.waitingCount:", this.pool.waitingCount,
      )
      console.log("----------------------------------------");
    }
    const result = await this.pool.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }

  public async load(table: string, conditions: any): Promise<any> {
    conditions = conditions || {};
    conditions.where = conditions.where || "1=1";
    conditions.limit = 1;
    conditions.cols = conditions.cols || '*';
    if (conditions.orderBy) {
      conditions.orderBy = 'order by ' + conditions.orderBy;
    } else {
      conditions.orderBy = '';
    }

    // table = "'" + table + "'";
    const sql = `select ${conditions.cols} from ${table} where ${conditions.where} ${conditions.orderBy} limit ${conditions.limit}`;
    const { rows } = await this.query(sql, conditions.params);
    if (rows.length > 0) {
      return rows[0];
    }
    return null;
  }

  public loadByKV(table: string, key: string, value: any) {
    return this.load(table, {
      where: key + " = $1",
      params: [value]
    });
  }

  public loadById(table: string, id: any) {
    return this.loadByKV(table, "id", id);
  }

  public async insert(table: string, data: any, returning?: string[]): Promise<any> {
    const keys = Object.keys(data);

    returning = returning || ["id"];

    let placeholders = [];
    let params = [];

    for (const keyIndex in keys) {
      const mIndex = ~~keyIndex;
      placeholders.push(`$${(mIndex + 1)}`);
      params.push(data[keys[mIndex]]);
    }

    const sql = `INSERT into ${table} (${keys.join(", ")}) values (${placeholders.join(", ")}) RETURNING ${returning.join(",")}`;

    const { rows } = await this.query(sql, params);
    return rows[0];
  }

  public async update(table: string, data: any, returning?: string[]): Promise<any> {
    if (!data.id) {
      throw new Error("The updated data must include the id.");
    }

    returning = returning || ["id"];
    const keys = Object.keys(data);
    const idIndex = keys.indexOf("id");
    // delete keys[idIndex];
    keys.splice(idIndex, 1);

    let placeholders = [];
    let params = [];

    for (const keyIndex in keys) {
      const mIndex = ~~keyIndex;
      placeholders.push(`$${(mIndex + 1)}`);
      params.push(data[keys[mIndex]]);
    }

    const sql = keys.length > 1 ?
      `UPDATE ${table} SET (${keys.join(", ")}) = (${placeholders.join(", ")}) WHERE id=${data.id} RETURNING ${returning.join(",")}` :
      `UPDATE ${table} SET ${keys.join(", ")} = ${placeholders.join(", ")} WHERE id=${data.id} RETURNING ${returning.join(",")}`;

    const { rows } = await this.query(sql, params);
    return rows[0];

  }

  public save(table: string, data: any, returning?: string[]): Promise<any> {
    if (data.id) {
      return this.update(table, data, returning);
    } else {
      return this.insert(table, data, returning);
    }
  }

  public async list(table: string, conditions: any): Promise<any> {
    conditions = conditions || {};
    if (!conditions.cols) {
      conditions.cols = '*';
    }
    if (!conditions.offset) {
      conditions.offset = 0;
    }
    if (!conditions.limit) {
      conditions.limit = 5;
    }
    if (!conditions.where) {
      conditions.where = "1=1"
    }
    if (conditions.orderBy) {
      conditions.orderBy = 'order by ' + conditions.orderBy;
    } else {
      conditions.orderBy = '';
    }
    // table = "`" + table + "`";
    const sql = `select ${conditions.cols} from ${table} where ${conditions.where} ${conditions.orderBy} limit ${conditions.limit} offset ${conditions.offset}`;
    const { rows } = await this.query(sql, conditions.params);
    return rows;
  }

  public async count(table: string, conditions: any): Promise<number> {
    conditions = conditions || {};
    conditions.where = conditions.where || "1=1";
    // table = "`" + table + "`";
    const sql = `select count(*) as ct from ${table} where ${conditions.where} `;
    const { rows } = await this.query(sql, conditions.params);
    if (rows.length > 0) {
      return rows[0].ct;
    }
    return 0;

  }


  public async exists(table: string, conditions: any): Promise<boolean> {
    conditions = conditions || {};
    conditions.where = conditions.where || "1=1";
    const sql = `select count(*) as ct from ${table} where ${conditions.where} `;
    const { rows } = await this.query(sql, conditions.params);
    return rows.length > 0 && rows[0].ct > 0;
  }



  public async sum(table: string, col: string, conditions: any): Promise<number> {
    conditions = conditions || {};
    conditions.where = conditions.where || "1=1";
    const sql = `select sum(${col}) as ct from ${table} where ${conditions.where} `;
    const { rows } = await this.query(sql, conditions.params);
    if (rows.length > 0) {
      return rows[0].ct;
    }
    return 0;
  }

  public async delete(table: string, id: any) {
    const sql = `delete from ${table} where id=$1`;
    const { rowCount } = await this.query(sql, [id]);
    return rowCount > 0;
  }

  public async deleteMulti(table: string, conditions: any) {
    conditions = conditions || {};
    // 拒绝无条件删除：where 缺失/null/空串/纯空白时，拼出的语句会退化成危险的
    // `delete from <table> where ...`（错误或恒操作），必须显式抛错而非兜底成 "1=1"
    // （对 delete 那等于删全表）。
    // 注意：恒真 where（如 "1=1"）仍能删全表，属已知残留风险，待产品拍板，不在本次范围。
    if (typeof conditions.where !== "string" || conditions.where.trim() === "") {
      throw new Error(
        `deleteMulti requires a non-empty "where" condition to avoid an unconditional delete of table "${table}"; received: ${JSON.stringify(conditions.where)}`
      );
    }
    const sql = `delete from ${table} where ${conditions.where} `;
    const { rowCount } = await this.query(sql, conditions.params);
    return rowCount > 0;
  }

}


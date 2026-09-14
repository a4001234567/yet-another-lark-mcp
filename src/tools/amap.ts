/**
 * Amap (高德) MCP tools — geocoding, POI search, weather, routing, distance.
 * Calls the Amap Web REST API. Requires AMAP_MAPS_API_KEY env (高德开放平台 Web服务类型 key).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import https from 'https';

const HOST = 'restapi.amap.com';

function getKey(): string {
  const k = process.env.AMAP_MAPS_API_KEY;
  if (!k) throw new Error('AMAP_MAPS_API_KEY env is not set');
  return k;
}

function amapGet(path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: HOST, path, method: 'GET', headers: { 'User-Agent': 'lark-mcp/amap' } },
      (r) => {
        let d = '';
        r.on('data', (c) => (d += c));
        r.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { reject(new Error('Invalid JSON from Amap')); }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function call(key: string, pathPrefix: string, query: Record<string, string | undefined>): Promise<string> {
  const qs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(v as string)}`)
    .join('&');
  const res = await amapGet(`${pathPrefix}?${qs}&key=${key}`);
  if (res.status !== '1') throw new Error(`Amap ${res.infocode ?? 'error'}: ${res.info ?? 'unknown'}`);
  return JSON.stringify(res, null, 2);
}

export function registerAmapTools(server: McpServer) {
  server.tool(
    'maps_geo',
    '将结构化地址转换为经纬度坐标（地理编码）。支持地标名胜、建筑名解析。address 必填，city 可选。',
    { address: z.string().describe('待解析的结构化地址'), city: z.string().optional().describe('指定查询城市') },
    async ({ address, city }) => ({ content: [{ type: 'text' as const, text: await call(getKey(), '/v3/geocode/geo', { address, city }) }] }),
  );

  server.tool(
    'maps_regeocode',
    '将一个经纬度坐标转换为行政区划地址信息（逆地理编码）。location 格式：经度,纬度',
    { location: z.string().describe('经纬度，如 112.6108,37.7916') },
    async ({ location }) => ({ content: [{ type: 'text' as const, text: await call(getKey(), '/v3/geocode/regeo', { location }) }] }),
  );

  server.tool(
    'maps_ip_location',
    '根据输入的 IP 地址定位所在省份/城市。缺省不传则用请求来源 IP。',
    { ip: z.string().optional().describe('IP 地址') },
    async ({ ip }) => ({ content: [{ type: 'text' as const, text: await call(getKey(), '/v3/ip', { ip }) }] }),
  );

  server.tool(
    'maps_text_search',
    '关键词搜索，根据用户传入关键词搜索相关 POI。keywords 必填，city/types 可筛选。',
    {
      keywords: z.string().describe('搜索关键词'),
      city: z.string().optional().describe('查询城市'),
      types: z.string().optional().describe('POI类型，如加油站的行业分类'),
    },
    async ({ keywords, city, types }) => ({
      content: [{ type: 'text' as const, text: await call(getKey(), '/v3/place/text', { keywords, city, types }) }],
    }),
  );

  server.tool(
    'maps_around_search',
    '周边搜，按中心点坐标+半径搜索 POI。location 格式：经度,纬度，radius 单位米。',
    {
      location: z.string().describe('中心点经度,纬度'),
      keywords: z.string().describe('搜索关键词，如 酒店/小区/地铁'),
      radius: z.string().optional().describe('搜索半径（米）'),
    },
    async ({ location, keywords, radius }) => ({
      content: [{ type: 'text' as const, text: await call(getKey(), '/v3/place/around', { location, keywords, radius }) }],
    }),
  );

  server.tool(
    'maps_search_detail',
    '查询关键词搜或周边搜获取到的 POI ID 的详细信息。id 为 POI 的唯一标识。',
    { id: z.string().describe('POI ID') },
    async ({ id }) => ({ content: [{ type: 'text' as const, text: await call(getKey(), '/v3/place/detail', { id }) }] }),
  );

  server.tool(
    'maps_weather',
    '根据城市名称或标准 adcode 查询指定城市的天气（未来4天）。',
    { city: z.string().describe('城市名称或 adcode，如 太原 或 140100') },
    async ({ city }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v3/weather/weatherInfo', { city, extensions: 'all' }) }] }
    ),
  );

  server.tool(
    'maps_distance',
    '测量两个经纬度坐标之间的距离。type：1=驾车，0=直线，3=步行。multiple 起点用 | 分隔。',
    {
      origins: z.string().describe('起点经度,纬度，可多个用 | 分隔，如 120,30|120,31'),
      destination: z.string().describe('终点经度,纬度'),
      type: z.string().optional().describe('1驾车 0直线 3步行'),
    },
    async ({ origins, destination, type }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v3/distance', { origins, destination, type }) }] }
    ),
  );

  server.tool(
    'maps_direction_driving',
    '驾车路径规划，根据起终点经纬度规划小客车通勤方案。坐标格式：经度,纬度',
    { origin: z.string().describe('出发点经度,纬度'), destination: z.string().describe('目的地经度,纬度') },
    async ({ origin, destination }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v3/direction/driving', { origin, destination }) }] }
    ),
  );

  server.tool(
    'maps_direction_walking',
    '步行路径规划，100km 以内。坐标格式：经度,纬度',
    { origin: z.string().describe('出发点经度,纬度'), destination: z.string().describe('目的地经度,纬度') },
    async ({ origin, destination }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v3/direction/walking', { origin, destination }) }] }
    ),
  );

  server.tool(
    'maps_direction_bicycling',
    '骑行路径规划，最大 500km，会考虑天桥、单行线等。坐标格式：经度,纬度',
    { origin: z.string().describe('出发点经度,纬度'), destination: z.string().describe('目的地经度,纬度') },
    async ({ origin, destination }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v4/direction/bicycling', { origin, destination }) }] }
    ),
  );

  server.tool(
    'maps_direction_transit_integrated',
    '综合公交/地铁/火车路径规划，跨城场景必须传 city(起点城市) 与 cityd(终点城市)。',
    {
      origin: z.string().describe('出发点经度,纬度'),
      destination: z.string().describe('目的地经度,纬度'),
      city: z.string().describe('公共交通规划起点城市'),
      cityd: z.string().describe('公共交通规划终点城市'),
    },
    async ({ origin, destination, city, cityd }) => (
      { content: [{ type: 'text' as const, text: await call(getKey(), '/v3/direction/transit/integrated', { origin, destination, city, cityd }) }] }
    ),
  );
}

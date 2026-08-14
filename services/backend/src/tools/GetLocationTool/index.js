/**
 * GetLocationTool — obtain the user's current geographic location.
 *
 * Delegates to services/geolocationService (single implementation point):
 * Windows location service first (high accuracy), IP geolocation fallback
 * (city-level). Permission prompting is handled by the executeTool funnel's
 * existing requestPermission chain — never implemented here.
 */
const geolocationService = require('../../services/geolocationService');
const { BaseTool } = require('../_baseTool');

class GetLocationTool extends BaseTool {
  static toolName = 'GetLocation';
  static category = 'system';
  // 'medium' triggers the permission prompt on first use under the normal
  // tier (repo risk vocabulary is safe/low/medium/high/critical).
  static risk = 'medium';
  static aliases = ['Geolocation', 'location'];
  static searchHint = 'location geolocation gps position coordinates where am i';

  isReadOnly() {
    return true;
  }
  isDestructive() {
    return false;
  }
  isConcurrencySafe() {
    return true;
  }

  prompt() {
    return `Gets the user's current geographic location.

The first use asks the user for authorization via the permission system.

Usage notes:
- On Windows, the system location service is tried first (high accuracy, exact coordinates)
- On other platforms, or when the system service is unavailable/denied, falls back to IP geolocation (city-level accuracy)
- Results are cached briefly; pass refresh=true to force a fresh lookup
- On failure the tool returns an error with actionable guidance — it never fabricates a location`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        refresh: {
          type: 'boolean',
          description: 'Bypass cached result and force a fresh location lookup',
        },
      },
      required: [],
    };
  }

  getActivityDescription() {
    return '获取设备当前位置';
  }

  async execute(params) {
    const refresh = params && params.refresh === true;
    const result = await geolocationService.getLocation({ refresh });

    if (!result.success) {
      return {
        success: false,
        error: result.error,
        guidance: result.guidance,
        content: `${result.error}\n${result.guidance}`,
      };
    }

    let summary;
    if (result.source === 'windows') {
      const acc = result.accuracy != null ? `，精度约 ${Math.round(result.accuracy)} 米` : '';
      summary = `定位成功：纬度 ${result.latitude}, 经度 ${result.longitude}（来源：Windows 位置服务${acc}）`;
    } else {
      const place = [result.country, result.region, result.city].filter(Boolean).join('');
      summary = `定位成功：${place || `纬度 ${result.latitude}, 经度 ${result.longitude}`}（来源：IP 定位，城市级精度）`;
    }

    return {
      success: true,
      content: summary,
      data: {
        latitude: result.latitude,
        longitude: result.longitude,
        accuracy: result.accuracy,
        city: result.city,
        region: result.region,
        country: result.country,
        source: result.source,
        timestamp: result.timestamp,
      },
    };
  }
}

module.exports = new GetLocationTool();
module.exports.GetLocationTool = GetLocationTool;

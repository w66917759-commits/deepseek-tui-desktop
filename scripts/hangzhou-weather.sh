#!/bin/bash
# 杭州天气定时查询脚本
# cron: 0 13 * * * /Users/west/project/deepseektuidesk/scripts/hangzhou-weather.sh

CITY="Hangzhou"
LOG_FILE="$HOME/hangzhou-weather.log"

# 使用 wttr.in 获取天气（无需 API Key）
WEATHER=$(curl -s "wttr.in/${CITY}?format=%t+%C" 2>/dev/null)

if [ -z "$WEATHER" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] 查询失败" >> "$LOG_FILE"
    exit 1
fi

# 解析温度和天气状况
TEMP=$(echo "$WEATHER" | awk '{print $1}')
COND=$(echo "$WEATHER" | awk '{$1=""; print $0}' | xargs)

# 判断是否下雨
RAIN="否"
case "$COND" in
    *[Rr]ain*|*[Dd]rizzle*|*[Ss]hower*|*雨*) RAIN="是" ;;
esac

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# 写入日志
{
    echo "===== $TIMESTAMP ====="
    echo "城市: 杭州"
    echo "温度: $TEMP"
    echo "是否下雨: $RAIN"
    echo ""
} >> "$LOG_FILE"

# 同时输出到终端（cron 会通过 mail 发送）
echo "[$TIMESTAMP] 杭州天气 — 温度: $TEMP, 下雨: $RAIN"

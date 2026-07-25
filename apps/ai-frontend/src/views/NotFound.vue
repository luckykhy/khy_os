<template>
  <div class="not-found-page">
    <KhyEmpty
      :icon="CompassIcon"
      title="这个页面走丢了"
      description="你访问的地址不存在，或内容已被移动 / 删除。"
    >
      <template #action>
        <div class="not-found-actions">
          <p v-if="counting" class="not-found-countdown" role="status" aria-live="polite">
            {{ seconds }} 秒后自动返回首页
            <el-button link type="primary" size="small" @click="stopCountdown">取消</el-button>
          </p>
          <div class="not-found-buttons">
            <el-button type="primary" @click="goHome">回首页</el-button>
            <el-button @click="goBack">返回上一页</el-button>
          </div>
          <div class="not-found-links">
            <router-link class="not-found-link" to="/home" @click="stopCountdown">首页</router-link>
            <span class="not-found-sep" aria-hidden="true">·</span>
            <router-link class="not-found-link" to="/chat" @click="stopCountdown">开始对话</router-link>
            <span class="not-found-sep" aria-hidden="true">·</span>
            <router-link class="not-found-link" to="/features" @click="stopCountdown">功能索引</router-link>
          </div>
        </div>
      </template>
    </KhyEmpty>
  </div>
</template>

<script setup>
// NotFound — 友好的 404 兜底页(承 goal「前端网页不要再出现 not found」)。
// 由 router 的 catch-all 路由 `/:pathMatch(.*)*` 命中:拼错 URL / 失效链接不再渲染
// 空白 <router-view>,而是一张有出路的引导页。
//
// 倒计时:3 秒后自动 router.replace('/home')(replace 而非 push,避免"返回"又回到坏地址)。
// 用户点击任意按钮/链接/取消即停表,绝不打断主动操作;组件卸载必清定时器。
import { ref, onMounted, onBeforeUnmount, markRaw } from 'vue'
import { useRouter } from 'vue-router'
import { Compass } from '@element-plus/icons-vue'
import KhyEmpty from '@/components/KhyEmpty.vue'

const CompassIcon = markRaw(Compass)
const AUTO_RETURN_SECONDS = 3

const router = useRouter()
const seconds = ref(AUTO_RETURN_SECONDS)
const counting = ref(true)
let timer = null

function stopCountdown() {
  counting.value = false
  if (timer) { clearInterval(timer); timer = null }
}

function goHome() {
  stopCountdown()
  router.replace('/home')
}

function goBack() {
  stopCountdown()
  // history 里没有上一页(如直接粘贴坏 URL 进来)时,回退到首页兜底。
  if (window.history.length > 1) router.back()
  else router.replace('/home')
}

onMounted(() => {
  timer = setInterval(() => {
    seconds.value -= 1
    if (seconds.value <= 0) {
      stopCountdown()
      router.replace('/home')
    }
  }, 1000)
})

onBeforeUnmount(stopCountdown)
</script>

<style scoped>
.not-found-page {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  padding: 24px;
}
.not-found-actions {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}
.not-found-countdown {
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
.not-found-buttons {
  display: flex;
  gap: 10px;
}
.not-found-links {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.not-found-link {
  color: var(--el-color-primary);
  text-decoration: none;
}
.not-found-link:hover {
  text-decoration: underline;
}
.not-found-sep {
  color: var(--el-text-color-disabled);
}
</style>

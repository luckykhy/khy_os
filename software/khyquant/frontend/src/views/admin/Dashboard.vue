<template>
  <div class="admin-panel">
    <!-- 顶部统计卡片 -->
    <el-row :gutter="16" class="stats-row">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-num">{{ stats.totalUsers }}</div>
          <div class="stat-label">注册用户</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-num">{{ stats.totalStrategies }}</div>
          <div class="stat-label">策略总数</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-num">{{ stats.totalAnnouncements }}</div>
          <div class="stat-label">公告总数</div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-num">{{ stats.onlineUsers }}</div>
          <div class="stat-label">当前在线</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 功能标签页 -->
    <el-tabs v-model="activeTab" type="border-card" class="main-tabs">

      <!-- ========== 系统概览 ========== -->
      <el-tab-pane label="系统概览" name="overview">
        <el-row :gutter="20">
          <el-col :span="12">
            <el-card>
              <template #header>
                <div class="section-header">
                  <span>系统状态</span>
                  <el-button text size="small" @click="loadSystemStatus">
                    <el-icon><Refresh /></el-icon>
                  </el-button>
                </div>
              </template>
              <div class="status-grid" v-loading="systemLoading">
                <div class="status-item">
                  <span>数据库</span>
                  <el-tag :type="systemStatus.database ? 'success' : 'danger'" size="small">
                    {{ systemStatus.database ? '正常' : '异常' }}
                  </el-tag>
                </div>
                <div class="status-item">
                  <span>WebSocket</span>
                  <el-tag :type="systemStatus.websocket ? 'success' : 'danger'" size="small">
                    {{ systemStatus.websocket ? '正常' : '异常' }}
                  </el-tag>
                </div>
                <div class="status-item">
                  <span>AI 服务</span>
                  <el-tag :type="systemStatus.aiService ? 'success' : 'warning'" size="small">
                    {{ systemStatus.aiService ? '正常' : '离线' }}
                  </el-tag>
                </div>
                <div class="status-item">
                  <span>系统负载</span>
                  <el-tag type="info" size="small">{{ systemStatus.load || '-' }}</el-tag>
                </div>
              </div>
            </el-card>
          </el-col>
          <el-col :span="12">
            <el-card>
              <template #header>
                <div class="section-header">
                  <span>最近动态</span>
                  <el-button text size="small" @click="loadActivities">
                    <el-icon><Refresh /></el-icon>
                  </el-button>
                </div>
              </template>
              <div class="activities-list" v-loading="activitiesLoading">
                <div v-for="a in activities" :key="a.id" class="activity-item">
                  <div class="activity-dot" />
                  <div class="activity-body">
                    <div class="activity-text">{{ a.description }}</div>
                    <div class="activity-time">{{ formatRelative(a.createdAt) }}</div>
                  </div>
                </div>
                <el-empty v-if="activities.length === 0 && !activitiesLoading" description="暂无动态" :image-size="60" />
              </div>
            </el-card>
          </el-col>
        </el-row>
      </el-tab-pane>

      <!-- ========== 用户管理 ========== -->
      <el-tab-pane label="用户管理" name="users">
        <div class="toolbar">
          <div class="toolbar-left">
            <el-input v-model="users.search" placeholder="搜索用户名/邮箱" clearable style="width:200px">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-select v-model="users.filterRole" placeholder="角色" clearable style="width:120px">
              <el-option label="全部角色" value="" />
              <el-option label="管理员" value="admin" />
              <el-option label="普通用户" value="user" />
            </el-select>
            <el-select v-model="users.filterStatus" placeholder="状态" clearable style="width:120px">
              <el-option label="全部状态" value="" />
              <el-option label="正常" value="active" />
              <el-option label="停用" value="inactive" />
              <el-option label="封禁" value="banned" />
            </el-select>
          </div>
          <div class="toolbar-right">
            <el-button type="primary" @click="users.showCreate = true">
              <el-icon><Plus /></el-icon> 新建用户
            </el-button>
            <el-button @click="fetchUsers" :loading="users.loading">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <el-table :data="filteredUsers" v-loading="users.loading" stripe>
          <el-table-column prop="id" label="ID" width="70" sortable />
          <el-table-column prop="username" label="用户名" min-width="120" sortable />
          <el-table-column prop="email" label="邮箱" min-width="180" />
          <el-table-column prop="role" label="角色" width="100">
            <template #default="{ row }">
              <el-tag :type="row.role === 'admin' ? 'danger' : 'primary'" size="small">
                {{ row.role === 'admin' ? '管理员' : '用户' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="userStatusType(row.status)" size="small">{{ userStatusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="lastLoginAt" label="最后登录" width="160">
            <template #default="{ row }">{{ row.lastLoginAt ? fmtDate(row.lastLoginAt) : '从未登录' }}</template>
          </el-table-column>
          <el-table-column prop="createdAt" label="注册时间" width="160">
            <template #default="{ row }">{{ fmtDate(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="220" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="openEditUser(row)">编辑</el-button>
              <el-button size="small" type="warning" @click="openResetPwd(row)">重置密码</el-button>
              <el-button size="small" type="danger" @click="deleteUser(row)" :disabled="row.id === userStore.user?.id">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="inline-stats">
          <el-statistic title="总计" :value="users.list.length" />
          <el-statistic title="管理员" :value="users.list.filter(u => u.role === 'admin').length" />
          <el-statistic title="正常" :value="users.list.filter(u => u.status === 'active').length" />
        </div>

        <!-- 新建用户对话框 -->
        <el-dialog v-model="users.showCreate" title="新建用户" width="480px" @close="resetCreateForm">
          <el-form ref="createFormRef" :model="users.createForm" :rules="users.createRules" label-width="80px">
            <el-form-item label="用户名" prop="username">
              <el-input v-model="users.createForm.username" />
            </el-form-item>
            <el-form-item label="邮箱" prop="email">
              <el-input v-model="users.createForm.email" />
            </el-form-item>
            <el-form-item label="密码" prop="password">
              <el-input v-model="users.createForm.password" type="password" show-password />
            </el-form-item>
            <el-form-item label="角色" prop="role">
              <el-select v-model="users.createForm.role">
                <el-option label="普通用户" value="user" />
                <el-option label="管理员" value="admin" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="users.showCreate = false">取消</el-button>
            <el-button type="primary" @click="handleCreateUser" :loading="users.createLoading">创建</el-button>
          </template>
        </el-dialog>

        <!-- 编辑用户对话框 -->
        <el-dialog v-model="users.showEdit" title="编辑用户" width="480px">
          <el-form ref="editFormRef" :model="users.editForm" :rules="users.editRules" label-width="80px">
            <el-form-item label="用户名" prop="username">
              <el-input v-model="users.editForm.username" />
            </el-form-item>
            <el-form-item label="邮箱" prop="email">
              <el-input v-model="users.editForm.email" />
            </el-form-item>
            <el-form-item label="角色" prop="role">
              <el-select v-model="users.editForm.role">
                <el-option label="普通用户" value="user" />
                <el-option label="管理员" value="admin" />
              </el-select>
            </el-form-item>
            <el-form-item label="状态" prop="status">
              <el-select v-model="users.editForm.status">
                <el-option label="正常" value="active" />
                <el-option label="停用" value="inactive" />
                <el-option label="封禁" value="banned" />
              </el-select>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="users.showEdit = false">取消</el-button>
            <el-button type="primary" @click="handleEditUser" :loading="users.editLoading">保存</el-button>
          </template>
        </el-dialog>

        <!-- 重置密码对话框 -->
        <el-dialog v-model="users.showPwd" title="重置密码" width="400px">
          <el-form ref="pwdFormRef" :model="users.pwdForm" :rules="users.pwdRules" label-width="90px">
            <el-form-item label="用户">
              <el-input :value="users.selectedUser?.username" disabled />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
              <el-input v-model="users.pwdForm.newPassword" type="password" show-password />
            </el-form-item>
            <el-form-item label="确认密码" prop="confirmPassword">
              <el-input v-model="users.pwdForm.confirmPassword" type="password" show-password />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="users.showPwd = false">取消</el-button>
            <el-button type="primary" @click="handleResetPwd" :loading="users.pwdLoading">确认重置</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- ========== 公告管理 ========== -->
      <el-tab-pane label="公告管理" name="announcements">
        <div class="toolbar">
          <div class="toolbar-left">
            <el-select v-model="ann.filterStatus" placeholder="状态" clearable @change="loadAnnouncements" style="width:120px">
              <el-option label="全部" value="" />
              <el-option label="已发布" value="published" />
              <el-option label="草稿" value="draft" />
              <el-option label="已归档" value="archived" />
            </el-select>
            <el-select v-model="ann.filterType" placeholder="类型" clearable @change="loadAnnouncements" style="width:120px">
              <el-option label="全部" value="" />
              <el-option label="系统" value="system" />
              <el-option label="维护" value="maintenance" />
              <el-option label="功能" value="feature" />
              <el-option label="警告" value="warning" />
              <el-option label="通知" value="info" />
            </el-select>
          </div>
          <div class="toolbar-right">
            <el-button type="primary" @click="showAnnCreate">
              <el-icon><Plus /></el-icon> 发布公告
            </el-button>
            <el-button @click="loadAnnouncements" :loading="ann.loading">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <el-table :data="ann.list" v-loading="ann.loading" stripe>
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="title" label="标题" min-width="200">
            <template #default="{ row }">
              <el-tag v-if="row.isSticky" type="danger" size="small" style="margin-right:4px">置顶</el-tag>
              <span>{{ row.title }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="90">
            <template #default="{ row }">
              <el-tag :type="annTypeColor(row.type)" size="small">{{ annTypeLabel(row.type) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="annStatusColor(row.status)" size="small">{{ annStatusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="actualReadCount" label="阅读" width="70" />
          <el-table-column prop="publishAt" label="发布时间" width="160">
            <template #default="{ row }">{{ fmtDate(row.publishAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="viewAnnouncement(row)">查看</el-button>
              <el-button size="small" type="primary" @click="editAnnouncement(row)">编辑</el-button>
              <el-button size="small" type="danger" @click="deleteAnnouncement(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="ann.total > 0"
          @current-change="(p) => { ann.page = p; loadAnnouncements() }"
          :current-page="ann.page" :page-size="ann.pageSize" :total="ann.total"
          layout="prev, pager, next, total"
          style="margin-top:16px; justify-content:center"
        />

        <!-- 创建/编辑公告对话框 -->
        <el-dialog :title="ann.dialogMode === 'create' ? '发布公告' : '编辑公告'" v-model="ann.dialogVisible" width="700px">
          <el-form ref="annFormRef" :model="ann.form" :rules="ann.formRules" label-width="80px">
            <el-form-item label="标题" prop="title">
              <el-input v-model="ann.form.title" />
            </el-form-item>
            <el-form-item label="内容" prop="content">
              <el-input v-model="ann.form.content" type="textarea" :rows="6" placeholder="支持 Markdown 格式" />
            </el-form-item>
            <el-row :gutter="20">
              <el-col :span="8">
                <el-form-item label="类型" prop="type">
                  <el-select v-model="ann.form.type">
                    <el-option label="系统" value="system" />
                    <el-option label="维护" value="maintenance" />
                    <el-option label="功能" value="feature" />
                    <el-option label="警告" value="warning" />
                    <el-option label="通知" value="info" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="优先级" prop="priority">
                  <el-select v-model="ann.form.priority">
                    <el-option label="紧急" value="urgent" />
                    <el-option label="高" value="high" />
                    <el-option label="普通" value="normal" />
                    <el-option label="低" value="low" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :span="8">
                <el-form-item label="发布时间">
                  <el-date-picker v-model="ann.form.publishAt" type="datetime" format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss" />
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="20">
              <el-col :span="12">
                <el-form-item label="过期时间">
                  <el-date-picker v-model="ann.form.expireAt" type="datetime" format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="选项">
                  <el-checkbox v-model="ann.form.isSticky">置顶</el-checkbox>
                  <el-checkbox v-model="ann.form.isPopup">弹窗显示</el-checkbox>
                </el-form-item>
              </el-col>
            </el-row>
          </el-form>
          <template #footer>
            <el-button @click="ann.dialogVisible = false">取消</el-button>
            <el-button type="primary" @click="saveAnnouncement" :loading="ann.saving">
              {{ ann.dialogMode === 'create' ? '发布' : '保存' }}
            </el-button>
          </template>
        </el-dialog>

        <!-- 查看公告对话框 -->
        <el-dialog title="公告详情" v-model="ann.viewVisible" width="650px">
          <div v-if="ann.current" class="detail-view">
            <h3>{{ ann.current.title }}</h3>
            <div class="detail-meta">
              <el-tag :type="annTypeColor(ann.current.type)" size="small">{{ annTypeLabel(ann.current.type) }}</el-tag>
              <span class="meta-time">{{ fmtDate(ann.current.publishAt) }}</span>
            </div>
            <pre class="detail-pre">{{ ann.current.content }}</pre>
            <p class="detail-footer">阅读数: {{ ann.current.actualReadCount || 0 }} | 作者: {{ ann.current.author?.username }}</p>
          </div>
        </el-dialog>
      </el-tab-pane>

      <!-- ========== 反馈管理 ========== -->
      <el-tab-pane name="feedback">
        <template #label>
          <span>反馈管理</span>
          <el-badge :value="fb.unreadCount" v-if="fb.unreadCount > 0" style="margin-left:6px" />
        </template>

        <div class="toolbar">
          <div class="toolbar-left">
            <el-select v-model="fb.filterType" placeholder="类型" clearable @change="loadFeedbacks" style="width:120px">
              <el-option label="全部" value="" />
              <el-option label="缺陷" value="bug" />
              <el-option label="建议" value="suggestion" />
              <el-option label="需求" value="feature" />
              <el-option label="其他" value="other" />
            </el-select>
            <el-select v-model="fb.filterStatus" placeholder="状态" clearable @change="loadFeedbacks" style="width:120px">
              <el-option label="全部" value="" />
              <el-option label="待处理" value="pending" />
              <el-option label="处理中" value="processing" />
              <el-option label="已解决" value="resolved" />
              <el-option label="已关闭" value="closed" />
            </el-select>
            <el-input v-model="fb.search" placeholder="搜索" clearable @keyup.enter="loadFeedbacks" style="width:180px">
              <template #append><el-button @click="loadFeedbacks" :icon="Search" /></template>
            </el-input>
          </div>
          <div class="toolbar-right">
            <el-button @click="loadFeedbacks" :loading="fb.loading">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <el-table :data="fb.list" v-loading="fb.loading" stripe>
          <el-table-column prop="id" label="ID" width="60" />
          <el-table-column prop="title" label="标题" min-width="200">
            <template #default="{ row }">
              <el-tag :type="fbPriorityColor(row.priority)" size="small" style="margin-right:4px">{{ fbPriorityLabel(row.priority) }}</el-tag>
              <span>{{ row.title }}</span>
            </template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="90">
            <template #default="{ row }">
              <el-tag :type="fbTypeColor(row.type)" size="small">{{ fbTypeLabel(row.type) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="用户" width="100">
            <template #default="{ row }">{{ row.user?.username }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="fbStatusColor(row.status)" size="small">{{ fbStatusLabel(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="createdAt" label="提交时间" width="160">
            <template #default="{ row }">{{ fmtDate(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="200" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="viewFeedback(row)">查看</el-button>
              <el-button size="small" type="primary" @click="openReplyFeedback(row)" :disabled="row.status === 'closed'">回复</el-button>
              <el-button size="small" type="danger" @click="deleteFeedback(row)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-pagination
          v-if="fb.total > 0"
          @current-change="(p) => { fb.page = p; loadFeedbacks() }"
          :current-page="fb.page" :page-size="fb.pageSize" :total="fb.total"
          layout="prev, pager, next, total"
          style="margin-top:16px; justify-content:center"
        />

        <!-- 查看反馈对话框 -->
        <el-dialog title="反馈详情" v-model="fb.viewVisible" width="700px">
          <div v-if="fb.current" class="detail-view">
            <h3>{{ fb.current.title }}</h3>
            <div class="detail-meta">
              <el-tag :type="fbTypeColor(fb.current.type)" size="small">{{ fbTypeLabel(fb.current.type) }}</el-tag>
              <el-tag :type="fbStatusColor(fb.current.status)" size="small">{{ fbStatusLabel(fb.current.status) }}</el-tag>
            </div>
            <pre class="detail-pre">{{ fb.current.content }}</pre>
            <p>用户: {{ fb.current.user?.username }} | 联系方式: {{ fb.current.contactInfo || '未提供' }} | {{ fmtDate(fb.current.createdAt) }}</p>
            <div v-if="fb.current.adminReply" class="admin-reply-box">
              <h4>管理员回复:</h4>
              <pre class="detail-pre reply-pre">{{ fb.current.adminReply }}</pre>
              <p class="reply-meta">由 {{ fb.current.admin?.username }} 回复于 {{ fmtDate(fb.current.repliedAt) }}</p>
            </div>
          </div>
        </el-dialog>

        <!-- 回复反馈对话框 -->
        <el-dialog title="回复反馈" v-model="fb.replyVisible" width="650px">
          <div v-if="fb.current" class="reply-form">
            <div class="feedback-summary">
              <h4>{{ fb.current.title }}</h4>
              <p>{{ fb.current.content }}</p>
            </div>
            <el-form ref="replyFormRef" :model="fb.replyForm" :rules="fb.replyRules" label-width="80px">
              <el-form-item label="回复" prop="adminReply">
                <el-input v-model="fb.replyForm.adminReply" type="textarea" :rows="5" />
              </el-form-item>
              <el-form-item label="状态" prop="status">
                <el-select v-model="fb.replyForm.status">
                  <el-option label="处理中" value="processing" />
                  <el-option label="已解决" value="resolved" />
                  <el-option label="已关闭" value="closed" />
                </el-select>
              </el-form-item>
            </el-form>
          </div>
          <template #footer>
            <el-button @click="fb.replyVisible = false">取消</el-button>
            <el-button type="primary" @click="submitReply" :loading="fb.replying">提交回复</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- ========== 系统设置 ========== -->
      <el-tab-pane label="系统设置" name="system">
        <div class="toolbar">
          <div class="toolbar-left">
            <el-button @click="initializeSettings" :loading="sys.initLoading">
              <el-icon><Setting /></el-icon> 初始化默认设置
            </el-button>
          </div>
          <div class="toolbar-right">
            <el-button type="primary" @click="saveSettings" :loading="sys.saveLoading">
              <el-icon><Check /></el-icon> 保存设置
            </el-button>
            <el-button @click="refreshSystemInfo" :loading="sys.infoLoading">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <el-row :gutter="20">
          <el-col :span="8">
            <el-card v-if="sys.systemInfo">
              <template #header><span>系统信息</span></template>
              <el-descriptions :column="1" border size="small">
                <el-descriptions-item label="系统名称">{{ sys.systemInfo.settings?.system?.find(s => s.key === 'system.name')?.value || 'KHY-Quant' }}</el-descriptions-item>
                <el-descriptions-item label="版本">{{ sys.systemInfo.settings?.system?.find(s => s.key === 'system.version')?.value || '1.0.0' }}</el-descriptions-item>
                <el-descriptions-item label="Node.js">{{ sys.systemInfo.systemInfo?.nodeVersion }}</el-descriptions-item>
                <el-descriptions-item label="平台">{{ sys.systemInfo.systemInfo?.platform }}</el-descriptions-item>
                <el-descriptions-item label="运行时间">{{ formatUptime(sys.systemInfo.systemInfo?.uptime) }}</el-descriptions-item>
                <el-descriptions-item label="内存使用">{{ formatMemory(sys.systemInfo.systemInfo?.memoryUsage?.used) }} / {{ formatMemory(sys.systemInfo.systemInfo?.memoryUsage?.total) }}</el-descriptions-item>
              </el-descriptions>
            </el-card>
          </el-col>
          <el-col :span="16">
            <el-card>
              <el-tabs v-model="sys.activeSettingsTab">
                <el-tab-pane
                  v-for="(settings, category) in sys.groupedSettings"
                  :key="category"
                  :label="sysCategoryLabel(category)"
                  :name="category"
                >
                  <el-form :model="sys.form" label-width="160px" style="padding:10px 0">
                    <el-form-item v-for="s in settings" :key="s.key" :label="s.description || s.key">
                      <el-switch v-if="s.type === 'boolean'" v-model="sys.form[s.key]" :disabled="!s.isEditable" />
                      <el-input-number v-else-if="s.type === 'number'" v-model="sys.form[s.key]" :disabled="!s.isEditable" style="width:200px" />
                      <el-input v-else-if="s.type === 'text'" v-model="sys.form[s.key]" type="textarea" :disabled="!s.isEditable" :rows="3" style="width:400px" />
                      <el-input v-else v-model="sys.form[s.key]" :disabled="!s.isEditable" style="width:300px" />
                      <el-button v-if="s.isEditable" size="small" style="margin-left:10px" @click="resetSetting(s.key)">重置</el-button>
                    </el-form-item>
                  </el-form>
                </el-tab-pane>
              </el-tabs>
            </el-card>
          </el-col>
        </el-row>

        <el-alert
          v-if="sys.form['system.maintenance_mode']"
          title="维护模式已开启 — 普通用户无法访问系统"
          type="warning" :closable="false" show-icon style="margin-top:16px"
        />

        <!-- K-Line Period Management -->
        <el-divider content-position="left">K线周期显示管理</el-divider>
        <el-card shadow="never" style="margin-bottom: 16px;">
          <div style="margin-bottom: 12px; color: #606266; font-size: 13px;">
            控制前端交易页面可见的K线时间周期。勾选后用户才能在交易页面切换对应周期。
          </div>
          <el-checkbox-group v-model="klinePeriods" @change="saveKlinePeriods">
            <el-checkbox label="1m" value="1m">1分钟线</el-checkbox>
            <el-checkbox label="5m" value="5m">5分钟线</el-checkbox>
            <el-checkbox label="15m" value="15m">15分钟线</el-checkbox>
            <el-checkbox label="30m" value="30m">30分钟线</el-checkbox>
            <el-checkbox label="1h" value="1h">1小时线</el-checkbox>
            <el-checkbox label="daily" value="daily" disabled>日线（默认）</el-checkbox>
            <el-checkbox label="weekly" value="weekly">周线</el-checkbox>
            <el-checkbox label="monthly" value="monthly">月线</el-checkbox>
          </el-checkbox-group>
          <div v-if="klinePeriodSaving" style="margin-top: 8px; color: #909399; font-size: 12px;">保存中...</div>
        </el-card>

        <!-- AKShare Version Management -->
        <el-divider content-position="left">AKShare 数据源版本管理</el-divider>
        <el-descriptions :column="2" border>
          <el-descriptions-item label="当前版本">
            <el-tag type="info">{{ akshareStatus.currentVersion || '检测中...' }}</el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="最新版本">
            <el-tag :type="akshareStatus.latestVersion && akshareStatus.currentVersion !== akshareStatus.latestVersion ? 'warning' : 'success'">
              {{ akshareStatus.latestVersion || '未知' }}
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="上次检查">
            {{ akshareStatus.lastCheckTime ? new Date(akshareStatus.lastCheckTime).toLocaleString('zh-CN') : '从未检查' }}
          </el-descriptions-item>
          <el-descriptions-item label="下次检查">
            {{ akshareStatus.nextCheckIn || '—' }}
          </el-descriptions-item>
        </el-descriptions>

        <div style="margin-top: 12px; display: flex; gap: 8px; align-items: center;">
          <el-button type="primary" @click="checkAKShare" :loading="akshareChecking" size="small">
            立即检查更新
          </el-button>
          <span v-if="akshareStatus.isUpdating" style="color: #e6a23c;">
            正在升级中...
          </span>
          <span v-if="akshareStatus.currentVersion && akshareStatus.currentVersion === akshareStatus.latestVersion" style="color: #67c23a;">
            已是最新版本
          </span>
        </div>

        <div v-if="akshareStatus.updateHistory?.length > 0" style="margin-top: 12px;">
          <div style="font-weight: 500; margin-bottom: 8px; color: #606266;">最近更新记录</div>
          <el-table :data="akshareStatus.updateHistory" size="small">
            <el-table-column label="时间" width="160">
              <template #default="{row}">{{ new Date(row.time).toLocaleString('zh-CN') }}</template>
            </el-table-column>
            <el-table-column label="升级路径" min-width="150">
              <template #default="{row}">{{ row.fromVersion }} → {{ row.toVersion }}</template>
            </el-table-column>
            <el-table-column label="结果" width="80">
              <template #default="{row}">
                <el-tag :type="row.success ? 'success' : 'danger'" size="small">
                  {{ row.success ? '成功' : '失败' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="duration" label="耗时" width="80" />
          </el-table>
        </div>
      </el-tab-pane>

      <!-- ========== 操作日志 ========== -->
      <el-tab-pane label="操作日志" name="logs">
        <div class="toolbar">
          <div class="toolbar-left">
            <el-input v-model="logs.filters.search" placeholder="搜索用户/描述" clearable style="width:200px" @keyup.enter="fetchLogs">
              <template #prefix><el-icon><Search /></el-icon></template>
            </el-input>
            <el-select v-model="logs.filters.action" placeholder="操作类型" clearable @change="fetchLogs" style="width:140px">
              <el-option label="全部" value="" />
              <el-option label="登录" value="login" />
              <el-option label="登出" value="logout" />
              <el-option label="注册" value="register" />
              <el-option label="修改密码" value="password_change" />
              <el-option label="管理员重置密码" value="password_reset_by_admin" />
              <el-option label="管理员删除账号" value="account_deleted_by_admin" />
              <el-option label="管理员更新" value="profile_update_by_admin" />
            </el-select>
            <el-select v-model="logs.filters.status" placeholder="状态" clearable @change="fetchLogs" style="width:110px">
              <el-option label="全部" value="" />
              <el-option label="成功" value="success" />
              <el-option label="失败" value="failed" />
              <el-option label="警告" value="warning" />
            </el-select>
            <el-date-picker
              v-model="logs.dateRange" type="datetimerange"
              range-separator="至" start-placeholder="开始时间" end-placeholder="结束时间"
              format="YYYY-MM-DD HH:mm:ss" value-format="YYYY-MM-DD HH:mm:ss"
              @change="handleLogDateChange"
            />
          </div>
          <div class="toolbar-right">
            <el-button @click="exportLogs" :loading="logs.exportLoading">
              <el-icon><Download /></el-icon> 导出
            </el-button>
            <el-button @click="logs.showCleanup = true">
              <el-icon><Delete /></el-icon> 清理
            </el-button>
            <el-button @click="fetchLogs" :loading="logs.loading">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>
        </div>

        <el-table :data="logs.list" v-loading="logs.loading" stripe>
          <el-table-column prop="id" label="ID" width="70" sortable />
          <el-table-column prop="username" label="用户" width="120" sortable />
          <el-table-column prop="action" label="操作" width="140">
            <template #default="{ row }">
              <el-tag :type="logActionType(row.action)" size="small">{{ logActionText(row.action) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="actionDescription" label="描述" min-width="200" />
          <el-table-column prop="ipAddress" label="IP 地址" width="130" />
          <el-table-column prop="status" label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="logStatusType(row.status)" size="small">{{ logStatusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="timestamp" label="时间" width="160">
            <template #default="{ row }">{{ fmtDate(row.timestamp) }}</template>
          </el-table-column>
          <el-table-column label="" width="80" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="viewLogDetail(row)">详情</el-button>
            </template>
          </el-table-column>
        </el-table>

        <div class="pagination-center">
          <el-pagination
            v-model:current-page="logs.page" v-model:page-size="logs.limit"
            :page-sizes="[10, 20, 50, 100]" :total="logs.total"
            layout="total, sizes, prev, pager, next"
            @size-change="fetchLogs" @current-change="fetchLogs"
          />
        </div>

        <!-- 日志详情对话框 -->
        <el-dialog title="日志详情" v-model="logs.showDetail" width="600px">
          <el-descriptions v-if="logs.selected" :column="1" border>
            <el-descriptions-item label="ID">{{ logs.selected.id }}</el-descriptions-item>
            <el-descriptions-item label="用户">{{ logs.selected.username }} (ID: {{ logs.selected.userId }})</el-descriptions-item>
            <el-descriptions-item label="操作">
              <el-tag :type="logActionType(logs.selected.action)" size="small">{{ logActionText(logs.selected.action) }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="描述">{{ logs.selected.actionDescription }}</el-descriptions-item>
            <el-descriptions-item label="IP 地址">{{ logs.selected.ipAddress || '-' }}</el-descriptions-item>
            <el-descriptions-item label="浏览器">{{ logs.selected.userAgent || '-' }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="logStatusType(logs.selected.status)" size="small">{{ logStatusText(logs.selected.status) }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="时间">{{ fmtDate(logs.selected.timestamp) }}</el-descriptions-item>
            <el-descriptions-item v-if="logs.selected.details" label="详细数据">
              <pre class="detail-pre">{{ JSON.stringify(logs.selected.details, null, 2) }}</pre>
            </el-descriptions-item>
          </el-descriptions>
        </el-dialog>

        <!-- 清理对话框 -->
        <el-dialog title="清理旧日志" v-model="logs.showCleanup" width="400px">
          <el-form label-width="100px">
            <el-form-item label="保留天数">
              <el-input-number v-model="logs.cleanupForm.daysToKeep" :min="1" :max="365" />
              <div style="font-size:12px;color:#909399;margin-top:4px">
                超过 {{ logs.cleanupForm.daysToKeep }} 天的日志将被永久删除
              </div>
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="logs.showCleanup = false">取消</el-button>
            <el-button type="danger" @click="handleCleanup" :loading="logs.cleanupLoading">确认清理</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

      <!-- ========== 资金管理 ========== -->
      <el-tab-pane label="资金管理" name="funds">
        <div class="toolbar">
          <div class="toolbar-left">
            <span style="font-weight:600">所有用户资金概览</span>
          </div>
          <div class="toolbar-right">
            <el-button @click="loadFunds" :loading="fundsLoading">
              <el-icon><Refresh /></el-icon> 刷新
            </el-button>
          </div>
        </div>

        <el-table :data="fundsData" v-loading="fundsLoading" stripe border>
          <el-table-column prop="username" label="用户名" width="120" />
          <el-table-column prop="email" label="邮箱" min-width="160" />
          <el-table-column label="初始资金" width="130">
            <template #default="{ row }">
              ¥{{ Number(row.initialFunds).toLocaleString() }}
            </template>
          </el-table-column>
          <el-table-column label="可用资金" width="130">
            <template #default="{ row }">
              <span :style="{ color: Number(row.availableFunds) >= row.initialFunds ? '#67c23a' : '#f56c6c' }">
                ¥{{ Number(row.availableFunds).toLocaleString() }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="累计盈亏" width="120">
            <template #default="{ row }">
              <span :style="{ color: Number(row.totalProfit) >= 0 ? '#67c23a' : '#f56c6c' }">
                {{ Number(row.totalProfit) >= 0 ? '+' : '' }}¥{{ Number(row.totalProfit).toLocaleString() }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="tradeCount" label="交易次数" width="90" />
          <el-table-column label="状态" width="80">
            <template #default="{ row }">
              <el-tag :type="row.status === 'active' ? 'success' : 'danger'" size="small">
                {{ row.status === 'active' ? '正常' : row.status === 'banned' ? '已封禁' : '未激活' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="100" fixed="right">
            <template #default="{ row }">
              <el-button size="small" @click="viewUserTrades(row.userId, row.username)">
                查看交易
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <!-- ========== 交易记录 ========== -->
      <el-tab-pane label="交易记录" name="trades">
        <el-form :inline="true" class="filter-form">
          <el-form-item label="用户">
            <el-input v-model="tradeFilter.userId" placeholder="用户ID" style="width:100px" clearable />
          </el-form-item>
          <el-form-item label="标的">
            <el-input v-model="tradeFilter.symbol" placeholder="如 sh600519" style="width:130px" clearable />
          </el-form-item>
          <el-form-item label="方向">
            <el-select v-model="tradeFilter.side" placeholder="全部" style="width:90px" clearable>
              <el-option label="买入" value="buy" />
              <el-option label="卖出" value="sell" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="tradeFilter.status" placeholder="全部" style="width:110px" clearable>
              <el-option label="待成交" value="pending" />
              <el-option label="已成交" value="filled" />
              <el-option label="已取消" value="cancelled" />
              <el-option label="已拒绝" value="rejected" />
            </el-select>
          </el-form-item>
          <el-form-item label="类型">
            <el-select v-model="tradeFilter.type" placeholder="全部" style="width:100px" clearable>
              <el-option label="模拟交易" value="paper" />
              <el-option label="回测" value="backtest" />
              <el-option label="实盘" value="live" />
            </el-select>
          </el-form-item>
          <el-form-item label="日期">
            <el-date-picker
              v-model="tradeFilter.dateRange"
              type="daterange"
              range-separator="至"
              start-placeholder="开始日期"
              end-placeholder="结束日期"
              style="width:220px"
              value-format="YYYY-MM-DD"
            />
          </el-form-item>
          <el-form-item>
            <el-button type="primary" @click="loadTrades">查询</el-button>
            <el-button @click="resetTradeFilter">重置</el-button>
          </el-form-item>
        </el-form>

        <el-alert
          v-if="tradeFilter.viewingUser"
          :title="`当前查看：${tradeFilter.viewingUser} 的交易记录`"
          type="info" show-icon closable
          @close="clearUserFilter"
          style="margin-bottom:12px"
        />

        <el-table :data="tradesData" v-loading="tradesLoading" stripe border>
          <el-table-column prop="id" label="订单ID" width="80" />
          <el-table-column label="用户" width="100">
            <template #default="{ row }">{{ row.user?.username || row.user_id }}</template>
          </el-table-column>
          <el-table-column prop="symbol" label="标的代码" width="110" />
          <el-table-column label="方向" width="70">
            <template #default="{ row }">
              <el-tag :type="row.side === 'buy' ? 'danger' : 'success'" size="small">
                {{ row.side === 'buy' ? '买入' : '卖出' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="90" />
          <el-table-column label="价格" width="100">
            <template #default="{ row }">¥{{ Number(row.price).toFixed(2) }}</template>
          </el-table-column>
          <el-table-column label="金额" width="120">
            <template #default="{ row }">¥{{ Number(row.amount).toLocaleString() }}</template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="{ pending:'warning', filled:'success', cancelled:'info', rejected:'danger' }[row.status]" size="small">
                {{ { pending:'待成交', filled:'已成交', cancelled:'已取消', rejected:'已拒绝' }[row.status] }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="类型" width="90">
            <template #default="{ row }">
              {{ { paper:'模拟', backtest:'回测', live:'实盘' }[row.type] || row.type }}
            </template>
          </el-table-column>
          <el-table-column label="盈亏" width="100">
            <template #default="{ row }">
              <span v-if="row.profit !== null && row.profit !== undefined" :style="{ color: Number(row.profit) >= 0 ? '#67c23a' : '#f56c6c' }">
                {{ Number(row.profit) >= 0 ? '+' : '' }}¥{{ Number(row.profit).toFixed(2) }}
              </span>
              <span v-else style="color:#909399">—</span>
            </template>
          </el-table-column>
          <el-table-column label="时间" min-width="150">
            <template #default="{ row }">{{ fmtDate(row.createdAt) }}</template>
          </el-table-column>
        </el-table>

        <div class="pagination-center">
          <el-pagination
            v-model:current-page="tradePage"
            v-model:page-size="tradePageSize"
            :total="tradeTotal"
            layout="total, sizes, prev, pager, next"
            :page-sizes="[20, 50, 100]"
            @size-change="loadTrades" @current-change="loadTrades"
          />
        </div>
      </el-tab-pane>

      <el-tab-pane label="AI Gateway" name="ai-gateway">
        <el-card class="gateway-config-card" shadow="never">
          <template #header>
            <div class="gateway-config-header">
              <div>
                <div class="gateway-config-title">模型与 API Key 配置</div>
                <div class="gateway-config-subtitle">
                  兼容 Hermes / OpenClaw / OpenCode 的 OpenAI-compatible 配置方式
                </div>
              </div>
              <div class="gateway-config-header-actions">
                <el-tag size="small" :type="relayConfig.snapshot.hasApiKey ? 'success' : 'warning'">
                  {{ relayConfig.snapshot.hasApiKey ? `已配置 Key (${relayConfig.snapshot.apiKeyMasked})` : '未配置 API Key' }}
                </el-tag>
                <el-button size="small" @click="loadRelayModelConfig" :loading="relayConfig.loading">
                  <el-icon><Refresh /></el-icon>
                </el-button>
              </div>
            </div>
          </template>

          <el-alert
            type="info"
            :closable="false"
            show-icon
            style="margin-bottom: 12px;"
            title="模型 ID 不是固定值，请按你实际接入的平台填写；Base URL 可自动补全 /v1"
          />

          <el-form :model="relayConfig.form" label-width="120px" class="gateway-config-form">
            <el-row :gutter="12">
              <el-col :xs="24" :md="8">
                <el-form-item label="配置预设">
                  <el-select v-model="relayConfig.form.profile" @change="handleRelayProfileChange" style="width: 100%;">
                    <el-option v-for="preset in relayProfilePresets" :key="preset.value" :label="preset.label" :value="preset.value" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="8">
                <el-form-item label="兼容协议">
                  <el-select v-model="relayConfig.form.compatibility" style="width: 100%;">
                    <el-option v-for="opt in relayCompatibilityOptions" :key="opt.value" :label="opt.label" :value="opt.value" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="8">
                <el-form-item label="模型 ID">
                  <el-input v-model="relayConfig.form.modelId" placeholder="如: gpt-4o-mini / sensenova-6.7-flash-lite / qwen-plus" />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="12">
              <el-col :xs="24" :md="12">
                <el-form-item label="Base URL">
                  <el-input v-model="relayConfig.form.baseUrl" placeholder="https://your-provider.com/v1" />
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="12">
                <el-form-item label="API Key">
                  <el-input
                    v-model="relayConfig.form.apiKey"
                    type="textarea"
                    :rows="3"
                    placeholder="支持 sk-xxx、Bearer sk-xxx、key=sk-xxx、JSON/多行多 Key"
                  />
                </el-form-item>
              </el-col>
            </el-row>

            <el-row :gutter="12">
              <el-col :xs="24" :md="18">
                <el-form-item label="当前生效">
                  <div class="gateway-current-meta">
                    <div>Adapter：{{ relayConfig.snapshot.preferredAdapter || '未指定' }}</div>
                    <div>Model：{{ relayConfig.snapshot.preferredModel || relayConfig.snapshot.modelId || '未指定' }}</div>
                    <div>Base URL：{{ relayConfig.snapshot.baseUrl || '未配置' }}</div>
                  </div>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :md="6">
                <el-form-item label="清空 Key">
                  <el-switch v-model="relayConfig.form.clearApiKey" />
                </el-form-item>
              </el-col>
            </el-row>

            <div class="gateway-config-actions">
              <el-button type="primary" @click="saveRelayModelConfig" :loading="relayConfig.saving">
                保存模型配置
              </el-button>
              <span class="gateway-config-hint">
                不勾选“清空 Key”且不填写 API Key 时，将保留当前 Key。
              </span>
            </div>
          </el-form>
        </el-card>

        <!-- Toolbar -->
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
          <span style="font-weight:600;font-size:15px;">API Key 池管理</span>
          <div>
            <el-button type="primary" size="small" @click="showAddKeyDialog">
              <el-icon><Plus /></el-icon> 添加 Key
            </el-button>
            <el-button size="small" @click="loadKeyPool" :loading="keyPool.loading">
              <el-icon><Refresh /></el-icon>
            </el-button>
            <el-button size="small" @click="openAIManagement">
              打开 AI 管理系统
            </el-button>
          </div>
        </div>

        <!-- Pool Overview Stats -->
        <el-row :gutter="12" style="margin-bottom:16px;">
          <el-col :span="4" v-for="(info, provider) in keyPool.data" :key="provider">
            <el-card shadow="hover" body-style="padding:12px;text-align:center;">
              <div style="font-size:20px;font-weight:600;color:var(--el-color-primary);">{{ info.length }}</div>
              <div style="font-size:12px;color:var(--el-text-color-regular);margin-top:4px;">{{ provider }}</div>
              <div style="font-size:11px;color:var(--el-text-color-secondary);margin-top:2px;">
                {{ info.filter(k => !k.cooldownUntil || k.cooldownUntil < Date.now()).length }} 可用 /
                {{ info.filter(k => k.cooldownUntil && k.cooldownUntil >= Date.now()).length }} 冷却
              </div>
            </el-card>
          </el-col>
        </el-row>

        <!-- Keys Table -->
        <el-table :data="keyPoolFlat" v-loading="keyPool.loading" stripe size="small" style="width:100%">
          <el-table-column prop="provider" label="供应商" width="100" />
          <el-table-column prop="keyPreview" label="Key" width="200">
            <template #default="{ row }">
              <code style="font-size:12px;">{{ row.keyPreview || maskKey(row.key) }}</code>
            </template>
          </el-table-column>
          <el-table-column prop="label" label="标签" width="100" />
          <el-table-column prop="priority" label="优先级" width="70" align="center" />
          <el-table-column label="状态" width="90" align="center">
            <template #default="{ row }">
              <el-tag :type="keyStatusType(row)" size="small">{{ keyStatusText(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="totalRequests" label="请求数" width="80" align="center" />
          <el-table-column prop="totalFailures" label="失败数" width="70" align="center" />
          <el-table-column prop="lastError" label="最后错误" min-width="160" show-overflow-tooltip />
          <el-table-column label="操作" width="80" fixed="right" align="center">
            <template #default="{ row }">
              <el-button size="small" type="danger" link @click="removePoolKey(row)">
                <el-icon><Delete /></el-icon>
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <!-- Add Key Dialog -->
        <el-dialog v-model="keyPool.addVisible" title="添加 API Key" width="480px" append-to-body>
          <el-form :model="keyPool.addForm" label-width="90px" size="default">
            <el-form-item label="供应商">
              <el-select v-model="keyPool.addForm.provider" placeholder="选择供应商" style="width:100%">
                <el-option v-for="p in keyProviders" :key="p" :label="p" :value="p" />
              </el-select>
            </el-form-item>
            <el-form-item label="API Key">
              <el-input v-model="keyPool.addForm.key" type="password" show-password placeholder="sk-ant-..." />
            </el-form-item>
            <el-form-item label="接口地址">
              <el-input v-model="keyPool.addForm.endpoint" placeholder="可选，如 https://api.anthropic.com/v1" />
            </el-form-item>
            <el-form-item label="标签">
              <el-input v-model="keyPool.addForm.label" placeholder="可选标识名" />
            </el-form-item>
            <el-form-item label="优先级">
              <el-input-number v-model="keyPool.addForm.priority" :min="0" :max="100" />
            </el-form-item>
          </el-form>
          <template #footer>
            <el-button @click="keyPool.addVisible = false">取消</el-button>
            <el-button type="primary" @click="handleAddKey" :loading="keyPool.addLoading">添加</el-button>
          </template>
        </el-dialog>
      </el-tab-pane>

    </el-tabs>
  </div>
</template>

<script setup>
// ---------------------------------------------------------------------------
// AdminDashboard —— 管理员后台控制面板
//
// 架构角色：属于前端交互层，对应论文第3.1节（图3 系统用例图 管理员角色）
//
// 功能说明：
//   管理员后台采用标签页（Tab）模式，一个组件承载多个管理功能：
//   - overview: 系统概览（用户数、策略数、在线人数统计）
//   - users: 用户管理（列表、搜索、禁用、密码重置、资金管理）
//   - announcements: 公告管理（发布、编辑、删除）
//   - feedback: 用户反馈查看
//   - system: 系统设置（参数配置）
//   - logs: 操作日志审计（对应论文表12 审计中间件）
//   - funds: 资金管理
//   - trades: 交易记录管理
//   - ai-gateway: AI网关管理
//
// 标签页切换：通过路由 meta.adminTab 控制当前激活标签
// ---------------------------------------------------------------------------
import { ref, reactive, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUserStore } from '@/stores/user'
import { ElMessage, ElMessageBox } from 'element-plus'
import {
  Refresh, Setting, Check, Plus, Search, Download, Delete
} from '@element-plus/icons-vue'
import request from '@/api/request'
import { adminAPI } from '@/api/admin'

const userStore = useUserStore()
const route = useRoute()
const router = useRouter()

// 打开AI管理系统——在新窗口中打开独立的AI管理前端
async function openAIManagement() {
  const port = import.meta.env.VITE_AI_FRONTEND_PORT || 8090
  const host = window.location.hostname
  const targetUrl = `${window.location.protocol}//${host}:${port}`

  // Quick check if AI frontend is reachable
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    await fetch(targetUrl, { mode: 'no-cors', signal: controller.signal })
    clearTimeout(timeout)
  } catch {
    ElMessage.warning({
      message: `AI 管理前端未运行 (${targetUrl})。请先启动: cd ai-frontend && npm run dev`,
      duration: 5000,
    })
    return
  }

  const popup = window.open(targetUrl, '_blank', 'noopener,noreferrer')
  if (!popup) {
    ElMessage.info('浏览器拦截了新窗口，请手动打开: ' + targetUrl)
  }
}

// ── 标签页持久化 ──
// 路由路径 → 标签页名称的映射表，实现URL与Tab双向同步
const ADMIN_PATH_TO_TAB = {
  '/admin/dashboard': 'overview',
  '/admin/users': 'users',
  '/admin/announcements': 'announcements',
  '/admin/feedback': 'feedback',
  '/admin/system': 'system',
  '/admin/logs': 'logs',
  '/admin/funds': 'funds',
  '/admin/trades': 'trades',
  '/admin/ai-gateway': 'ai-gateway',
  '/admin/ai': 'ai-gateway',
  '/admin/ai-management': 'ai-gateway'
}
const ADMIN_TAB_TO_PATH = {
  overview: '/admin/dashboard',
  users: '/admin/users',
  announcements: '/admin/announcements',
  feedback: '/admin/feedback',
  system: '/admin/system',
  logs: '/admin/logs',
  funds: '/admin/funds',
  trades: '/admin/trades',
  'ai-gateway': '/admin/ai-gateway'
}

const initialTab = route.meta?.adminTab || ADMIN_PATH_TO_TAB[route.path] || localStorage.getItem('adminActiveTab') || 'overview'
const activeTab = ref(initialTab)
const aiFrontendPort = import.meta.env.VITE_AI_FRONTEND_PORT || 8090

watch(() => route.path, (path) => {
  const tab = route.meta?.adminTab || ADMIN_PATH_TO_TAB[path]
  if (tab && tab !== activeTab.value) activeTab.value = tab
}, { immediate: true })

watch(activeTab, (val) => {
  localStorage.setItem('adminActiveTab', val)
  const targetPath = ADMIN_TAB_TO_PATH[val]
  if (targetPath && route.path !== targetPath) {
    router.replace(targetPath).catch(() => {})
  }
})

// ── 通用工具函数 ──
// 格式化日期为中文本地化字符串
const fmtDate = (d) => d ? new Date(d).toLocaleString('zh-CN') : '-'

// 将时间戳转为相对时间描述（如"3分钟前"、"2小时前"）
const formatRelative = (time) => {
  if (!time) return ''
  const diff = Date.now() - new Date(time).getTime()
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return new Date(time).toLocaleDateString('zh-CN')
}

// 将秒数转为"X天 X小时 X分钟"的可读格式
const formatUptime = (s) => {
  if (!s) return '-'
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d > 0 ? `${d}天 ${h}小时 ${m}分钟` : h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`
}

// 将字节数转为MB显示
const formatMemory = (bytes) => bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '-'

// ═══════════════════════════════════════
// 顶部统计卡片数据
// ═══════════════════════════════════════
const stats = reactive({ totalUsers: 0, totalStrategies: 0, totalAnnouncements: 0, onlineUsers: 0 })

// 从后端获取系统统计数据（用户数、策略数、公告数、在线人数）
const loadStats = async () => {
  try {
    const r = await request.get('/admin/stats')
    if (r.success) Object.assign(stats, r.data)
  } catch { /* keep zeros */ }
}

// ═══════════════════════════════════════
// 系统概览
// ═══════════════════════════════════════
const systemLoading = ref(false)
const activitiesLoading = ref(false)
const systemStatus = reactive({ database: false, websocket: false, aiService: false, load: '-' })
const akshareStatus = ref({})
const akshareChecking = ref(false)
const activities = ref([])

// 加载系统运行状态（数据库、WebSocket、AI服务、系统负载）
const loadSystemStatus = async () => {
  systemLoading.value = true
  try {
    const r = await request.get('/admin/system-status')
    if (r.success) Object.assign(systemStatus, r.data)
  } catch { /* keep defaults */ }
  finally { systemLoading.value = false }
}

// 加载最近系统动态列表
const loadActivities = async () => {
  activitiesLoading.value = true
  try {
    const r = await request.get('/admin/activities')
    if (r.success) activities.value = r.data
  } catch { /* keep empty */ }
  finally { activitiesLoading.value = false }
}

// ═══════════════════════════════════════
// 用户管理（对应论文第3.1节 管理员用例：用户CRUD）
// ═══════════════════════════════════════
// 用户管理状态：列表数据、搜索筛选条件、对话框表单及校验规则
const users = reactive({
  loading: false, list: [], search: '', filterRole: '', filterStatus: '',
  showCreate: false, showEdit: false, showPwd: false,
  createLoading: false, editLoading: false, pwdLoading: false,
  selectedUser: null,
  createForm: { username: '', email: '', password: '', role: 'user' },
  createRules: {
    username: [{ required: true, message: '请输入用户名', trigger: 'blur' }, { min: 3, max: 50, message: '3-50个字符', trigger: 'blur' }],
    email: [{ required: true, message: '请输入邮箱', trigger: 'blur' }, { type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
    password: [{ required: true, message: '请输入密码', trigger: 'blur' }, { min: 6, message: '至少6个字符', trigger: 'blur' }],
    role: [{ required: true, message: '请选择角色', trigger: 'change' }]
  },
  editForm: { id: null, username: '', email: '', role: '', status: '' },
  editRules: {
    username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
    email: [{ required: true, message: '请输入邮箱', trigger: 'blur' }, { type: 'email', message: '邮箱格式不正确', trigger: 'blur' }],
    role: [{ required: true, message: '请选择角色', trigger: 'change' }],
    status: [{ required: true, message: '请选择状态', trigger: 'change' }]
  },
  pwdForm: { newPassword: '', confirmPassword: '' },
  pwdRules: {
    newPassword: [{ required: true, message: '请输入新密码', trigger: 'blur' }, { min: 6, message: '至少6个字符', trigger: 'blur' }],
    confirmPassword: [{ required: true, message: '请确认密码', trigger: 'blur' }]
  }
})

const createFormRef = ref()
const editFormRef = ref()
const pwdFormRef = ref()

// 前端筛选：按关键词、角色、状态过滤用户列表
const filteredUsers = computed(() => {
  let r = users.list
  if (users.search) { const kw = users.search.toLowerCase(); r = r.filter(u => u.username.toLowerCase().includes(kw) || u.email.toLowerCase().includes(kw)) }
  if (users.filterRole) r = r.filter(u => u.role === users.filterRole)
  if (users.filterStatus) r = r.filter(u => u.status === users.filterStatus)
  return r
})

const userStatusType = (s) => ({ active: 'success', inactive: 'warning', banned: 'danger' })[s] || 'info'
const userStatusText = (s) => ({ active: '正常', inactive: '停用', banned: '封禁' })[s] || s

// 从后端获取全部用户列表
const fetchUsers = async () => {
  users.loading = true
  try { const r = await adminAPI.getUsers(); if (r.success) users.list = r.data }
  catch (e) { ElMessage.error(e.response?.data?.message || '加载用户列表失败') }
  finally { users.loading = false }
}

const resetCreateForm = () => { Object.assign(users.createForm, { username: '', email: '', password: '', role: 'user' }) }
const openEditUser = (u) => { users.selectedUser = u; Object.assign(users.editForm, { id: u.id, username: u.username, email: u.email, role: u.role, status: u.status }); users.showEdit = true }
const openResetPwd = (u) => { users.selectedUser = u; users.pwdForm.newPassword = ''; users.pwdForm.confirmPassword = ''; users.showPwd = true }

// 创建新用户——校验表单后调用后端API
const handleCreateUser = async () => {
  try { await createFormRef.value.validate(); users.createLoading = true
    const r = await adminAPI.createUser(users.createForm)
    if (r.success) { ElMessage.success('用户创建成功'); users.showCreate = false; fetchUsers(); loadStats() }
  } catch (e) { if (e.response) ElMessage.error(e.response.data?.message || '创建失败') }
  finally { users.createLoading = false }
}

// 编辑用户信息（用户名、邮箱、角色、状态）
const handleEditUser = async () => {
  try { await editFormRef.value.validate(); users.editLoading = true
    const { id, username, email, role, status } = users.editForm
    const r = await adminAPI.updateUser(id, { username, email, role, status })
    if (r.success) { ElMessage.success('用户更新成功'); users.showEdit = false; fetchUsers() }
  } catch (e) { if (e.response) ElMessage.error(e.response.data?.message || '更新失败') }
  finally { users.editLoading = false }
}

// 管理员重置用户密码（需二次确认密码一致性）
const handleResetPwd = async () => {
  try { await pwdFormRef.value.validate()
    if (users.pwdForm.newPassword !== users.pwdForm.confirmPassword) { ElMessage.error('两次输入的密码不一致'); return }
    users.pwdLoading = true
    const r = await adminAPI.resetUserPassword(users.selectedUser.id, users.pwdForm.newPassword)
    if (r.success) { ElMessage.success('密码重置成功'); users.showPwd = false }
  } catch (e) { if (e.response) ElMessage.error(e.response.data?.message || '重置失败') }
  finally { users.pwdLoading = false }
}

// 删除用户——二次确认后调用后端删除API（不能删除自己）
const deleteUser = async (u) => {
  if (u.id === userStore.user?.id) { ElMessage.warning('不能删除自己的账号'); return }
  try {
    await ElMessageBox.confirm(`确定要删除用户 "${u.username}" 吗？此操作不可撤销。`, '确认删除', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    const r = await adminAPI.deleteUser(u.id)
    if (r.success) { ElMessage.success('用户已删除'); fetchUsers(); loadStats() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('删除失败') }
}

// ═══════════════════════════════════════
// 公告管理（支持草稿/发布/归档生命周期，支持置顶和弹窗显示）
// ═══════════════════════════════════════
const ann = reactive({
  loading: false, saving: false, list: [], total: 0, page: 1, pageSize: 10,
  filterStatus: '', filterType: '',
  dialogVisible: false, viewVisible: false, dialogMode: 'create', current: null,
  form: { title: '', content: '', type: 'info', priority: 'normal', publishAt: '', expireAt: '', isSticky: false, isPopup: false },
  formRules: {
    title: [{ required: true, message: '请输入标题', trigger: 'blur' }],
    content: [{ required: true, message: '请输入内容', trigger: 'blur' }],
    type: [{ required: true, message: '请选择类型', trigger: 'change' }],
    priority: [{ required: true, message: '请选择优先级', trigger: 'change' }]
  }
})
const annFormRef = ref()

const annTypeColor = (t) => ({ system: 'danger', maintenance: 'warning', feature: 'success', warning: 'warning', info: 'info' })[t] || 'info'
const annTypeLabel = (t) => ({ system: '系统', maintenance: '维护', feature: '功能', warning: '警告', info: '通知' })[t] || t
const annStatusColor = (s) => ({ published: 'success', draft: 'warning', archived: 'info' })[s] || 'info'
const annStatusLabel = (s) => ({ published: '已发布', draft: '草稿', archived: '已归档' })[s] || s

// 分页加载公告列表，支持按状态和类型筛选
const loadAnnouncements = async () => {
  ann.loading = true
  try {
    const params = { page: ann.page, pageSize: ann.pageSize }
    if (ann.filterStatus) params.status = ann.filterStatus
    if (ann.filterType) params.type = ann.filterType
    const r = await request.get('/announcements/admin', { params })
    if (r.success) { ann.list = r.data.list; ann.total = r.data.total }
  } catch { ElMessage.error('加载公告列表失败') }
  finally { ann.loading = false }
}

const showAnnCreate = () => {
  ann.dialogMode = 'create'
  Object.assign(ann.form, { title: '', content: '', type: 'info', priority: 'normal', publishAt: '', expireAt: '', isSticky: false, isPopup: false })
  ann.current = null; ann.dialogVisible = true
}
const editAnnouncement = (a) => {
  ann.dialogMode = 'edit'; ann.current = a
  Object.assign(ann.form, { title: a.title, content: a.content, type: a.type, priority: a.priority, publishAt: a.publishAt, expireAt: a.expireAt, isSticky: a.isSticky, isPopup: a.isPopup })
  ann.dialogVisible = true
}
const viewAnnouncement = (a) => { ann.current = a; ann.viewVisible = true }

// 保存公告（新建调POST，编辑调PUT）
const saveAnnouncement = async () => {
  try { await annFormRef.value.validate(); ann.saving = true
    const r = ann.dialogMode === 'create'
      ? await request.post('/announcements', { ...ann.form })
      : await request.put(`/announcements/${ann.current.id}`, { ...ann.form })
    if (r.success) { ElMessage.success(ann.dialogMode === 'create' ? '发布成功' : '保存成功'); ann.dialogVisible = false; loadAnnouncements(); loadStats() }
  } catch { ElMessage.error('保存失败') }
  finally { ann.saving = false }
}

const deleteAnnouncement = async (a) => {
  try {
    await ElMessageBox.confirm(`确定要删除公告 "${a.title}" 吗？`, '确认删除', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    const r = await request.delete(`/announcements/${a.id}`)
    if (r.success) { ElMessage.success('删除成功'); loadAnnouncements(); loadStats() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('删除失败') }
}

// ═══════════════════════════════════════
// 反馈管理（查看用户反馈、管理员回复、状态流转）
// ═══════════════════════════════════════
const fb = reactive({
  loading: false, replying: false, list: [], total: 0, page: 1, pageSize: 10,
  filterType: '', filterStatus: '', search: '',
  viewVisible: false, replyVisible: false, current: null, unreadCount: 0,
  replyForm: { adminReply: '', status: 'processing' },
  replyRules: { adminReply: [{ required: true, message: '请输入回复内容', trigger: 'blur' }], status: [{ required: true, message: '请选择状态', trigger: 'change' }] }
})
const replyFormRef = ref()

const fbTypeColor = (t) => ({ bug: 'danger', suggestion: 'success', feature: 'primary', other: 'info' })[t] || 'info'
const fbTypeLabel = (t) => ({ bug: '缺陷', suggestion: '建议', feature: '需求', other: '其他' })[t] || t
const fbPriorityColor = (p) => ({ urgent: 'danger', high: 'warning', normal: 'info', low: 'success' })[p] || 'info'
const fbPriorityLabel = (p) => ({ urgent: '紧急', high: '高', normal: '普通', low: '低' })[p] || p
const fbStatusColor = (s) => ({ pending: 'warning', processing: 'primary', resolved: 'success', closed: 'info' })[s] || 'info'
const fbStatusLabel = (s) => ({ pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' })[s] || s

// 分页加载反馈列表，支持类型、状态、关键词筛选
const loadFeedbacks = async () => {
  fb.loading = true
  try {
    const params = { page: fb.page, pageSize: fb.pageSize }
    if (fb.filterType) params.type = fb.filterType
    if (fb.filterStatus) params.status = fb.filterStatus
    if (fb.search) params.search = fb.search
    const r = await request.get('/feedback/admin/list', { params })
    if (r.success) { fb.list = r.data.list; fb.total = r.data.total }
  } catch { ElMessage.error('加载反馈列表失败') }
  finally { fb.loading = false }
}

const loadFeedbackStats = async () => {
  try { const r = await request.get('/feedback/admin/stats'); if (r.success) fb.unreadCount = r.data.pending || 0 } catch { /* */ }
}

const viewFeedback = (f) => { fb.current = f; fb.viewVisible = true }
const openReplyFeedback = (f) => {
  fb.current = f; fb.replyForm.adminReply = f.adminReply || ''
  fb.replyForm.status = f.status === 'pending' ? 'processing' : f.status
  fb.replyVisible = true
}

// 管理员提交反馈回复，同时更新反馈状态
const submitReply = async () => {
  try { await replyFormRef.value.validate(); fb.replying = true
    const r = await request.put(`/feedback/admin/${fb.current.id}/reply`, fb.replyForm)
    if (r.success) { ElMessage.success('回复成功'); fb.replyVisible = false; loadFeedbacks(); loadFeedbackStats() }
  } catch { ElMessage.error('回复失败') }
  finally { fb.replying = false }
}

const deleteFeedback = async (f) => {
  try {
    await ElMessageBox.confirm(`确定要删除反馈 "${f.title}" 吗？`, '确认删除', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    const r = await request.delete(`/feedback/admin/${f.id}`)
    if (r.success) { ElMessage.success('删除成功'); loadFeedbacks(); loadFeedbackStats() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('删除失败') }
}

// ═══════════════════════════════════════
// 系统设置（对应论文第4.2节 系统参数动态配置）
// ═══════════════════════════════════════
const sys = reactive({
  infoLoading: false, saveLoading: false, initLoading: false,
  systemInfo: null, groupedSettings: {}, form: {}, activeSettingsTab: 'system'
})

const sysCategoryLabel = (c) => ({ system: '通用', user: '用户', security: '安全', trading: '交易', data: '数据', notification: '通知' })[c] || c

// 加载系统信息和所有配置项，按分类分组后填充到表单
const refreshSystemInfo = async () => {
  sys.infoLoading = true
  try {
    const r = await adminAPI.getSystemInfo()
    if (r.success) {
      sys.systemInfo = r.data; sys.groupedSettings = r.data.settings
      Object.keys(r.data.settings).forEach(cat => r.data.settings[cat].forEach(s => { sys.form[s.key] = s.value }))
    }
  } catch { ElMessage.error('加载系统信息失败') }
  finally { sys.infoLoading = false }
}

// 批量保存系统设置到后端
const saveSettings = async () => {
  try {
    await ElMessageBox.confirm('确定要保存系统设置吗？部分设置可能需要重启生效。', '确认保存', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    sys.saveLoading = true
    const r = await adminAPI.updateSystemSettings(sys.form)
    if (r.success) { ElMessage.success('设置保存成功'); refreshSystemInfo() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('保存失败') }
  finally { sys.saveLoading = false }
}

const resetSetting = async (key) => {
  try {
    await ElMessageBox.confirm(`确定要将 "${key}" 重置为默认值吗？`, '确认重置', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    const r = await adminAPI.resetSystemSetting(key)
    if (r.success) { sys.form[key] = r.data.value; ElMessage.success('已重置') }
  } catch (e) { if (e !== 'cancel') ElMessage.error('重置失败') }
}

const initializeSettings = async () => {
  try {
    await ElMessageBox.confirm('确定要初始化所有默认设置吗？', '确认初始化', { type: 'info', confirmButtonText: '确定', cancelButtonText: '取消' })
    sys.initLoading = true
    const r = await adminAPI.initializeSystemSettings()
    if (r.success) { ElMessage.success('初始化成功'); refreshSystemInfo() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('初始化失败') }
  finally { sys.initLoading = false }
}

// ═══════════════════════════════════════
// K线周期管理——控制前端可见的K线时间周期
// ═══════════════════════════════════════
const klinePeriods = ref(['daily'])
const klinePeriodSaving = ref(false)

const loadKlinePeriods = async () => {
  try {
    const r = await request.get('/settings/public', { params: { category: 'trading' }, silentLoading: true })
    if (r.success && Array.isArray(r.data)) {
      const item = r.data.find(s => s.key === 'kline.enabled_periods')
      const rawValue = item ? (item.value ?? item.parsedValue ?? item.defaultValue) : null
      if (rawValue) {
        const periods = Array.isArray(rawValue) ? rawValue : JSON.parse(rawValue)
        if (Array.isArray(periods) && periods.length > 0) klinePeriods.value = periods
      }
      if (!klinePeriods.value.includes('daily')) klinePeriods.value.push('daily')
    }
  } catch { /* use default */ }
}

const saveKlinePeriods = async (val) => {
  // Ensure 'daily' is always present
  if (!val.includes('daily')) val.push('daily')
  klinePeriodSaving.value = true
  try {
    await request.put('/settings/kline.enabled_periods', { value: val, type: 'json', category: 'trading', description: 'Allowed K-line periods for frontend display', isPublic: true })
    ElMessage.success('K线周期设置已保存')
  } catch { ElMessage.error('保存K线周期设置失败') }
  finally { klinePeriodSaving.value = false }
}

// ═══════════════════════════════════════
// AKShare数据源版本管理——检测和升级Python金融数据接口库
// ═══════════════════════════════════════
const loadAKShareStatus = async () => {
  try {
    const res = await request.get('/admin/akshare/status')
    if (res.success) akshareStatus.value = res.data
  } catch (e) { console.error('Failed to load AKShare status:', e) }
}

const checkAKShare = async () => {
  akshareChecking.value = true
  try {
    const res = await request.post('/admin/akshare/check')
    if (res.success) {
      if (res.data.success) {
        ElMessage.success(`AKShare已升级到 ${res.data.toVersion}`)
      } else if (res.data.upToDate) {
        ElMessage.success('AKShare已是最新版本')
      } else if (res.data.skipped) {
        ElMessage.info('检查跳过: ' + res.data.reason)
      } else {
        ElMessage.error('升级失败: ' + (res.data.error || '未知错误'))
      }
      await loadAKShareStatus()
    }
  } catch (e) {
    ElMessage.error('检查失败: ' + e.message)
  } finally {
    akshareChecking.value = false
  }
}

// ═══════════════════════════════════════
// 操作日志审计（对应论文表12 审计中间件，记录所有用户操作）
// ═══════════════════════════════════════
const logs = reactive({
  loading: false, exportLoading: false, cleanupLoading: false,
  list: [], total: 0, page: 1, limit: 20, dateRange: [],
  showDetail: false, showCleanup: false, selected: null,
  filters: { search: '', action: '', status: '', startDate: '', endDate: '' },
  cleanupForm: { daysToKeep: 90 }
})

const logActionType = (a) => ({ login: 'success', logout: 'info', register: 'primary', password_change: 'warning', password_reset_by_admin: 'danger', account_deleted_by_admin: 'danger', profile_update_by_admin: 'warning' })[a] || 'info'
const logActionText = (a) => ({ login: '登录', logout: '登出', register: '注册', password_change: '修改密码', password_reset_by_admin: '管理员重置密码', account_deleted_by_admin: '管理员删除', profile_update_by_admin: '管理员更新', account_created_by_admin: '管理员创建', system_settings_update: '更新设置', system_setting_reset: '重置设置', system_settings_initialize: '初始化设置' })[a] || a
const logStatusType = (s) => ({ success: 'success', failed: 'danger', warning: 'warning' })[s] || 'info'
const logStatusText = (s) => ({ success: '成功', failed: '失败', warning: '警告' })[s] || s

// 分页获取操作日志，支持按关键词、操作类型、状态、时间范围筛选
const fetchLogs = async () => {
  logs.loading = true
  try {
    const params = { page: logs.page, limit: logs.limit }
    if (logs.filters.search) params.search = logs.filters.search
    if (logs.filters.action) params.action = logs.filters.action
    if (logs.filters.status) params.status = logs.filters.status
    if (logs.filters.startDate) params.startDate = logs.filters.startDate
    if (logs.filters.endDate) params.endDate = logs.filters.endDate
    const r = await adminAPI.getUserLogs(params)
    if (r.success) { logs.list = r.data.logs; logs.total = r.data.total }
  } catch { ElMessage.error('加载日志失败') }
  finally { logs.loading = false }
}

const handleLogDateChange = (dates) => {
  if (dates?.length === 2) { logs.filters.startDate = dates[0]; logs.filters.endDate = dates[1] }
  else { logs.filters.startDate = ''; logs.filters.endDate = '' }
  logs.page = 1; fetchLogs()
}

const viewLogDetail = (l) => { logs.selected = l; logs.showDetail = true }

// 导出日志到文件
const exportLogs = async () => {
  try { logs.exportLoading = true; await adminAPI.exportUserLogs(logs.filters); ElMessage.success('导出成功') }
  catch { ElMessage.error('导出失败') }
  finally { logs.exportLoading = false }
}

// 清理过期日志——删除指定天数之前的日志记录
const handleCleanup = async () => {
  try {
    await ElMessageBox.confirm(`确定要删除 ${logs.cleanupForm.daysToKeep} 天前的日志吗？此操作不可撤销。`, '确认清理', { type: 'warning', confirmButtonText: '确定', cancelButtonText: '取消' })
    logs.cleanupLoading = true
    const r = await adminAPI.cleanOldLogs(logs.cleanupForm.daysToKeep)
    if (r.success) { ElMessage.success(`已清理 ${r.data.deletedCount} 条日志`); logs.showCleanup = false; fetchLogs() }
  } catch (e) { if (e !== 'cancel') ElMessage.error('清理失败') }
  finally { logs.cleanupLoading = false }
}

// ═══════════════════════════════════════
// 资金管理——查看所有用户的资金概览（初始资金、可用资金、累计盈亏）
// ═══════════════════════════════════════
const fundsData = ref([])
const fundsLoading = ref(false)

const loadFunds = async () => {
  fundsLoading.value = true
  try {
    const r = await request.get('/admin/funds')
    if (r.success) fundsData.value = r.data
  } catch { ElMessage.error('加载资金数据失败') }
  finally { fundsLoading.value = false }
}

// 从资金管理跳转到交易记录标签页，自动过滤该用户
const viewUserTrades = (userId, username) => {
  tradeFilter.userId = String(userId)
  tradeFilter.viewingUser = username
  activeTab.value = 'trades'
  loadTrades()
}

// ═══════════════════════════════════════
// 交易记录管理——支持多维度筛选查看所有用户的交易订单
// ═══════════════════════════════════════
const tradesData = ref([])
const tradesLoading = ref(false)
const tradeTotal = ref(0)
const tradePage = ref(1)
const tradePageSize = ref(20)
const tradeFilter = reactive({
  userId: '',
  symbol: '',
  side: '',
  status: '',
  type: '',
  dateRange: null,
  viewingUser: ''
})

// 分页加载交易记录，支持按用户、标的、方向、状态、类型、日期筛选
const loadTrades = async () => {
  tradesLoading.value = true
  try {
    const params = { page: tradePage.value, pageSize: tradePageSize.value }
    if (tradeFilter.userId) params.userId = tradeFilter.userId
    if (tradeFilter.symbol) params.symbol = tradeFilter.symbol
    if (tradeFilter.side) params.side = tradeFilter.side
    if (tradeFilter.status) params.status = tradeFilter.status
    if (tradeFilter.type) params.type = tradeFilter.type
    if (tradeFilter.dateRange) {
      params.startDate = tradeFilter.dateRange[0]
      params.endDate = tradeFilter.dateRange[1]
    }
    const r = await request.get('/admin/trades', { params })
    if (r.success) {
      tradesData.value = r.data
      tradeTotal.value = r.total
    }
  } catch { ElMessage.error('加载交易记录失败') }
  finally { tradesLoading.value = false }
}

const resetTradeFilter = () => {
  Object.assign(tradeFilter, { userId: '', symbol: '', side: '', status: '', type: '', dateRange: null, viewingUser: '' })
  tradePage.value = 1
  loadTrades()
}

const clearUserFilter = () => {
  tradeFilter.userId = ''
  tradeFilter.viewingUser = ''
  loadTrades()
}

// ── 组件挂载时初始化所有数据 ──
onMounted(() => {
  loadStats()
  loadSystemStatus()
  loadActivities()
  fetchUsers()
  loadAnnouncements()
  loadFeedbacks()
  loadFeedbackStats()
  refreshSystemInfo()
  fetchLogs()
  loadKlinePeriods()
})

const relayProfilePresets = [
  { value: 'custom', label: '自定义（手动填写）', baseUrl: '', compatibility: 'openai' },
  { value: 'hermes', label: 'Hermes 风格', baseUrl: '', compatibility: 'openai' },
  { value: 'openclaw', label: 'OpenClaw 风格', baseUrl: '', compatibility: 'openai' },
  { value: 'opencode', label: 'OpenCode 风格', baseUrl: '', compatibility: 'openai' },
]

const relayCompatibilityOptions = [
  { value: 'openai', label: 'OpenAI-compatible' },
  { value: 'anthropic', label: 'Anthropic-compatible' },
  { value: 'unknown', label: 'Auto / Unknown' },
]

const relayConfig = reactive({
  loading: false,
  saving: false,
  loaded: false,
  form: {
    profile: 'custom',
    baseUrl: '',
    modelId: '',
    apiKey: '',
    compatibility: 'openai',
    clearApiKey: false,
  },
  snapshot: {
    baseUrl: '',
    modelId: '',
    compatibility: 'openai',
    preferredAdapter: '',
    preferredModel: '',
    hasApiKey: false,
    apiKeyMasked: '',
  },
})

function applyRelaySnapshot(snapshot = {}) {
  relayConfig.snapshot.baseUrl = snapshot.baseUrl || ''
  relayConfig.snapshot.modelId = snapshot.modelId || ''
  relayConfig.snapshot.compatibility = snapshot.compatibility || 'openai'
  relayConfig.snapshot.preferredAdapter = snapshot.preferredAdapter || ''
  relayConfig.snapshot.preferredModel = snapshot.preferredModel || ''
  relayConfig.snapshot.hasApiKey = !!snapshot.hasApiKey
  relayConfig.snapshot.apiKeyMasked = snapshot.apiKeyMasked || ''

  relayConfig.form.baseUrl = snapshot.baseUrl || ''
  relayConfig.form.modelId = snapshot.modelId || ''
  relayConfig.form.compatibility = snapshot.compatibility || 'openai'
  relayConfig.form.apiKey = ''
  relayConfig.form.clearApiKey = false
}

function handleRelayProfileChange(profile) {
  const preset = relayProfilePresets.find(item => item.value === profile)
  if (!preset) return
  relayConfig.form.baseUrl = preset.baseUrl || relayConfig.form.baseUrl
  relayConfig.form.compatibility = preset.compatibility || relayConfig.form.compatibility
}

async function loadRelayModelConfig() {
  relayConfig.loading = true
  try {
    const r = await request.get('/ai-gateway-admin/model-config', { silentLoading: true })
    if (r?.success && r.data) {
      applyRelaySnapshot(r.data)
      relayConfig.form.profile = 'custom'
      relayConfig.loaded = true
      return
    }
    ElMessage.error('加载模型配置失败：后端返回格式不正确')
  } catch (e) {
    ElMessage.error((e.response && e.response.data && e.response.data.error) || '加载模型配置失败')
  } finally {
    relayConfig.loading = false
  }
}

async function saveRelayModelConfig() {
  const baseUrl = String(relayConfig.form.baseUrl || '').trim()
  const modelId = String(relayConfig.form.modelId || '').trim()
  const compatibility = String(relayConfig.form.compatibility || 'openai').trim()
  const apiKey = String(relayConfig.form.apiKey || '').trim()
  const clearApiKey = relayConfig.form.clearApiKey === true

  if (!baseUrl || !modelId) {
    ElMessage.warning('Base URL 和模型 ID 必填')
    return
  }

  const payload = { baseUrl, modelId, compatibility, clearApiKey }
  if (apiKey && !clearApiKey) payload.apiKey = apiKey

  relayConfig.saving = true
  try {
    const r = await request.put('/ai-gateway-admin/model-config', payload, { silentLoading: true })
    if (r?.success && r.data?.config) {
      applyRelaySnapshot(r.data.config)
      relayConfig.form.profile = 'custom'
      relayConfig.loaded = true
      const successText = r.data.appendedV1
        ? '模型配置已保存，系统已自动补全 /v1'
        : '模型配置已保存'
      ElMessage.success(successText)
      return
    }
    ElMessage.error('保存模型配置失败：后端返回格式不正确')
  } catch (e) {
    ElMessage.error((e.response && e.response.data && e.response.data.error) || '保存模型配置失败')
  } finally {
    relayConfig.saving = false
  }
}

// ══════ API Key Pool 管理 ══════
const keyProviders = ['anthropic', 'openai', 'codex', 'deepseek', 'qwen', 'glm', 'doubao', 'wenxin', 'relay', 'trae']

const keyPool = reactive({
  loading: false,
  addLoading: false,
  addVisible: false,
  data: {},
  addForm: { provider: 'anthropic', key: '', endpoint: '', label: '', priority: 10 },
})

const keyPoolFlat = computed(() => {
  const rows = []
  for (const [provider, keys] of Object.entries(keyPool.data)) {
    for (const k of keys) {
      rows.push({ ...k, provider })
    }
  }
  return rows
})

function maskKey(key) {
  if (!key || key.length < 10) return key || ''
  return key.slice(0, 6) + '...' + key.slice(-4)
}

function keyStatusType(row) {
  if (row.cooldownUntil && row.cooldownUntil >= Date.now()) return 'warning'
  if (row.disabled) return 'danger'
  return 'success'
}

function keyStatusText(row) {
  if (row.cooldownUntil && row.cooldownUntil >= Date.now()) return '冷却中'
  if (row.disabled) return '已禁用'
  return '可用'
}

async function loadKeyPool() {
  keyPool.loading = true
  try {
    const r = await request.get('/ai-gateway-admin/pool')
    if (r && typeof r === 'object') keyPool.data = r
  } catch { ElMessage.error('加载 Key Pool 失败') }
  finally { keyPool.loading = false }
}

function showAddKeyDialog() {
  keyPool.addForm = { provider: 'anthropic', key: '', endpoint: '', label: '', priority: 10 }
  keyPool.addVisible = true
}

async function handleAddKey() {
  if (!keyPool.addForm.provider || !keyPool.addForm.key) {
    ElMessage.warning('供应商和 Key 必填')
    return
  }
  keyPool.addLoading = true
  try {
    await request.post(`/ai-gateway-admin/pool/${keyPool.addForm.provider}/keys`, {
      key: keyPool.addForm.key,
      endpoint: keyPool.addForm.endpoint || undefined,
      priority: keyPool.addForm.priority,
      label: keyPool.addForm.label || undefined,
    })
    ElMessage.success('Key 添加成功')
    keyPool.addVisible = false
    loadKeyPool()
  } catch (e) {
    ElMessage.error((e.response && e.response.data && e.response.data.error) || '添加失败')
  } finally { keyPool.addLoading = false }
}

async function removePoolKey(row) {
  try {
    await ElMessageBox.confirm(
      `确定要删除 ${row.provider} 的 Key「${row.keyPreview || maskKey(row.key)}」吗？`,
      '确认删除',
      { type: 'warning' }
    )
    await request.delete(`/ai-gateway-admin/pool/${row.provider}/keys/${row.keyId}`)
    ElMessage.success('已删除')
    loadKeyPool()
  } catch (e) {
    if (e !== 'cancel') ElMessage.error('删除失败')
  }
}

function loadAiGatewayData(force = false) {
  const tasks = []
  if (force || Object.keys(keyPool.data).length === 0) tasks.push(loadKeyPool())
  if (force || !relayConfig.loaded) tasks.push(loadRelayModelConfig())
  if (tasks.length === 0) return
  Promise.all(tasks).catch(() => {})
}

// 懒加载：切换到资金/交易/系统标签页时才请求数据，减少初始加载压力
watch(activeTab, (tab) => {
  if (tab === 'funds' && fundsData.value.length === 0) loadFunds()
  if (tab === 'trades' && tradesData.value.length === 0) loadTrades()
  if (tab === 'system') loadAKShareStatus()
  if (tab === 'ai-gateway') loadAiGatewayData()
}, { immediate: true })
</script>

<style scoped>
.admin-panel {
  width: 100%;
}

/* 统计卡片 */
.stats-row {
  margin-bottom: 20px;
}
.stat-card {
  text-align: center;
  cursor: default;
}
.stat-card :deep(.el-card__body) {
  padding: 20px;
}
.stat-num {
  font-size: 32px;
  font-weight: 700;
  color: #303133;
  line-height: 1.2;
}
.stat-label {
  font-size: 13px;
  color: #909399;
  margin-top: 6px;
}

/* 标签页 */
.main-tabs {
  min-height: 500px;
}
.main-tabs :deep(.el-tabs__content) {
  padding: 16px;
}

/* 区块头部 */
.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-weight: 600;
}

/* 系统状态 */
.status-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.status-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px;
  background: #fafafa;
  border-radius: 6px;
}

/* 最近动态 */
.activities-list {
  max-height: 260px;
  overflow-y: auto;
}
.activity-item {
  display: flex;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid #f5f5f5;
}
.activity-item:last-child {
  border-bottom: none;
}
.activity-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #409eff;
  margin-top: 6px;
  flex-shrink: 0;
}
.activity-text {
  font-size: 13px;
  color: #303133;
}
.activity-time {
  font-size: 12px;
  color: #909399;
}

/* 工具栏 */
.toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  flex-wrap: wrap;
  gap: 10px;
}
.toolbar-left {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
}
.toolbar-right {
  display: flex;
  gap: 8px;
}

/* AI Gateway 配置卡片 */
.gateway-config-card {
  margin-bottom: 16px;
}
.gateway-config-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.gateway-config-title {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}
.gateway-config-subtitle {
  margin-top: 4px;
  color: #909399;
  font-size: 12px;
}
.gateway-config-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.gateway-current-meta {
  width: 100%;
  line-height: 1.6;
  color: #606266;
  font-size: 13px;
  background: #fafafa;
  border: 1px solid #ebeef5;
  border-radius: 6px;
  padding: 8px 10px;
}
.gateway-config-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 4px;
}
.gateway-config-hint {
  color: #909399;
  font-size: 12px;
}

/* 内联统计 */
.inline-stats {
  display: flex;
  gap: 40px;
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #ebeef5;
}

/* 分页居中 */
.pagination-center {
  display: flex;
  justify-content: center;
  margin-top: 16px;
}

/* 详情视图 */
.detail-view h3 {
  margin: 0 0 8px 0;
}
.detail-meta {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  align-items: center;
}
.meta-time {
  color: #909399;
  font-size: 13px;
}
.detail-pre {
  white-space: pre-wrap;
  word-wrap: break-word;
  background: #f8f9fa;
  padding: 12px;
  border-radius: 6px;
  border-left: 3px solid #409eff;
  line-height: 1.6;
  color: #606266;
  margin: 8px 0;
  font-size: 13px;
  max-height: 300px;
  overflow-y: auto;
}
.detail-footer {
  color: #909399;
  font-size: 13px;
  margin-top: 8px;
}

/* 反馈相关 */
.admin-reply-box {
  background: #f0f9ff;
  border: 1px solid #e1f5fe;
  border-radius: 6px;
  padding: 12px;
  margin-top: 12px;
}
.admin-reply-box h4 {
  margin: 0 0 8px 0;
  color: #1976d2;
}
.reply-pre {
  border-left-color: #67c23a;
}
.reply-meta {
  color: #909399;
  font-size: 12px;
  margin-top: 6px;
}
.feedback-summary {
  background: #f8f9fa;
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 16px;
}
.feedback-summary h4 {
  margin: 0 0 6px 0;
}
.feedback-summary p {
  margin: 0;
  color: #606266;
  line-height: 1.5;
}

/* 筛选表单 */
.filter-form {
  margin-bottom: 16px;
}
.filter-form .el-form-item {
  margin-bottom: 10px;
}

/* 响应式 */
@media (max-width: 768px) {
  .stats-row .el-col {
    flex: 0 0 50%;
    max-width: 50%;
    margin-bottom: 12px;
  }
  .status-grid {
    grid-template-columns: 1fr;
  }
  .toolbar {
    flex-direction: column;
    align-items: stretch;
  }
  .gateway-config-header {
    flex-direction: column;
  }
  .gateway-config-actions {
    flex-direction: column;
    align-items: flex-start;
  }
  .inline-stats {
    flex-direction: column;
    gap: 12px;
  }
}
</style>

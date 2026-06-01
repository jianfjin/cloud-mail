<template>
  <div class="box">
    <div class="container">
      <div class="title">{{$t('profile')}}</div>
      <div class="item">
        <div>{{$t('username')}}</div>
        <div>
          <span v-if="setNameShow" class="edit-name-input">
            <el-input v-model="accountName"  ></el-input>
            <span class="edit-name" @click="setName">
             {{$t('save')}}
            </span>
          </span>
          <span v-else class="user-name">
            <span >{{ userStore.user.name }}</span>
            <span class="edit-name" @click="showSetName">
             {{$t('change')}}
            </span>
          </span>
        </div>
      </div>
      <div class="item">
        <div>{{$t('emailAccount')}}</div>
        <div>{{ userStore.user.email }}</div>
      </div>
      <div class="item">
        <div>{{$t('password')}}</div>
        <div>
          <el-button type="primary" @click="pwdShow = true">{{$t('changePwdBtn')}}</el-button>
        </div>
      </div>
    </div>

    <!-- Accounts Section -->
    <div class="container" v-perm="'account:query'">
      <div class="title account-title">
        <span>{{$t('account')}}</span>
        <Icon v-perm="'account:add'" class="icon add" icon="ion:add-outline" width="23" height="23" @click="addAccount"/>
      </div>
      <div v-if="accountsLoading" class="loading-accounts">
        <el-skeleton :rows="3" animated />
      </div>
      <div v-else-if="accounts.length === 0" class="empty-accounts">
        {{$t('noMessagesFound')}}
      </div>
      <div v-else class="account-list">
        <div class="account-item" v-for="item in accounts" :key="item.accountId">
          <div class="account-email">
            <span>{{ item.email }}</span>
            <span v-if="item.name" class="account-name">({{ item.name }})</span>
          </div>
          <div class="account-actions">
            <el-button size="small" text @click="openRename(item)">{{$t('rename')}}</el-button>
            <el-button size="small" text @click="openSignature(item)">{{$t('signature')}}</el-button>
            <el-button v-if="item.accountId !== userStore.user.account.accountId" size="small" text @click="pinAccount(item)">
              <Icon icon="fluent:pin-24-regular" width="16" height="16"/>
            </el-button>
            <el-button v-if="item.accountId !== userStore.user.account.accountId && hasPerm('account:delete')" size="small" text type="danger" @click="removeAccount(item)">
              {{$t('delete')}}
            </el-button>
          </div>
        </div>
      </div>
    </div>

    <div class="del-email" v-perm="'my:delete'">
      <div class="title">{{$t('deleteUser')}}</div>
      <div style="color: var(--regular-text-color);">
        {{$t('delAccountMsg')}}
      </div>
      <div>
        <el-button type="primary" @click="deleteConfirm">{{$t('deleteUserBtn')}}</el-button>
      </div>
    </div>

    <!-- Rename Dialog -->
    <el-dialog v-model="renameShow" :title="$t('changeUserName')" width="340">
      <div class="container">
        <el-input v-model="renameValue" type="text" :placeholder="$t('username')" autocomplete="off">
        </el-input>
        <el-button class="btn" type="primary" @click="saveRename" :loading="renameLoading"
        >{{$t('save')}}
        </el-button>
      </div>
    </el-dialog>

    <!-- Signature Dialog -->
    <el-dialog
        v-model="signatureShow"
        :title="$t('editSignature')"
        class="signature-dialog"
        @closed="closeSignature"
        width="680px"
    >
      <div class="signature-editor">
        <tiny-editor
            ref="signatureEditor"
            editor-id="settings-signature-editor"
            :def-value="signatureValue"
            @change="onSignatureChange"
        />
      </div>
      <div class="signature-actions">
        <el-button @click="signatureShow = false" :disabled="signatureLoading">{{$t('cancel')}}</el-button>
        <el-button type="primary" @click="saveSignature" :loading="signatureLoading">{{$t('save')}}</el-button>
      </div>
    </el-dialog>

    <!-- Password Dialog -->
    <el-dialog v-model="pwdShow" :title="$t('changePassword')" width="340">
      <div class="update-pwd">
        <el-input type="password" :placeholder="$t('newPassword')" v-model="form.password" autocomplete="off"/>
        <el-input type="password" :placeholder="$t('confirmPassword')" v-model="form.newPwd" autocomplete="off"/>
        <el-button type="primary" :loading="setPwdLoading" @click="submitPwd">{{$t('save')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import {reactive, ref, onMounted} from 'vue'
import {resetPassword, userDelete} from "@/request/my.js";
import {accountList, accountSetName, accountSetSignature, accountSetAsTop, accountDelete} from "@/request/account.js";
import {useUserStore} from "@/store/user.js";
import router from "@/router/index.js";
import {useAccountStore} from "@/store/account.js";
import {useI18n} from "vue-i18n";
import {hasPerm} from "@/perm/perm.js"
import {Icon} from "@iconify/vue";
import tinyEditor from "@/components/tiny-editor/index.vue";

const { t } = useI18n()
const accountStore = useAccountStore()
const userStore = useUserStore();
const setPwdLoading = ref(false)
const setNameShow = ref(false)
const accountName = ref(null)

const accounts = ref([])
const accountsLoading = ref(false)

// Rename
const renameShow = ref(false)
const renameLoading = ref(false)
const renameValue = ref('')
let renameAccount = null

// Signature
const signatureShow = ref(false)
const signatureLoading = ref(false)
const signatureValue = ref('')
const signatureEditor = ref({})
let signatureAccount = null

defineOptions({
  name: 'setting'
})

onMounted(() => {
  if (hasPerm('account:query')) {
    loadAccounts()
  }
})

function loadAccounts() {
  accountsLoading.value = true
  accountList(0, 100, null).then(list => {
    accounts.value = list
  }).finally(() => {
    accountsLoading.value = false
  })
}

function showSetName() {
  accountName.value = userStore.user.name
  setNameShow.value = true
}

function setName() {
  if (!accountName.value) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return;
  }
  setNameShow.value = false
  let name = accountName.value
  if (name === userStore.user.name) {
    return
  }
  userStore.user.name = accountName.value
  accountSetName(userStore.user.account.accountId,name).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    accountStore.changeUserAccountName = name
  }).catch(() => {
    userStore.user.name = name
  })
}

const pwdShow = ref(false)
const form = reactive({
  password: '',
  newPwd: '',
})

const deleteConfirm = () => {
  ElMessageBox.confirm(t('delAccountConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    userDelete().then(() => {
      localStorage.removeItem('token');
      router.replace('/login');
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}

function submitPwd() {
  if (!form.password) {
    ElMessage({
      message: t('emptyPwdMsg'),
      type: 'error',
      plain: true,
    })
    return
  }
  if (form.password.length < 6) {
    ElMessage({
      message: t('pwdLengthMsg'),
      type: 'error',
      plain: true,
    })
    return
  }
  if (form.password !== form.newPwd) {
    ElMessage({
      message: t('confirmPwdFailMsg'),
      type: 'error',
      plain: true,
    })
    return
  }
  setPwdLoading.value = true
  resetPassword(form.password).then(() => {
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
    pwdShow.value = false
    setPwdLoading.value = false
    form.password = ''
    form.newPwd = ''
  }).catch(() => {
    setPwdLoading.value = false
  })
}

// --- Account management ---
function openRename(accountItem) {
  renameAccount = accountItem
  renameValue.value = accountItem.name || ''
  renameShow.value = true
}

function saveRename() {
  if (!renameAccount) return
  const name = renameValue.value
  if (!name) {
    ElMessage({
      message: t('emptyUserNameMsg'),
      type: 'error',
      plain: true,
    })
    return
  }
  renameLoading.value = true
  accountSetName(renameAccount.accountId, name).then(() => {
    renameAccount.name = name
    renameShow.value = false
    if (renameAccount.accountId === userStore.user.account.accountId) {
      userStore.user.name = name
      accountStore.changeUserAccountName = name
    }
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).finally(() => {
    renameLoading.value = false
  })
}

function openSignature(accountItem) {
  signatureAccount = accountItem
  signatureValue.value = accountItem.signature || ''
  signatureShow.value = true
}

function onSignatureChange(content) {
  signatureValue.value = content
}

function closeSignature() {
  signatureAccount = null
  signatureValue.value = ''
}

function saveSignature() {
  if (!signatureAccount) return
  const nextSignature = signatureEditor.value?.getContent?.() ?? signatureValue.value
  signatureLoading.value = true
  accountSetSignature(signatureAccount.accountId, nextSignature).then((signature) => {
    signatureAccount.signature = signature
    if (accountStore.currentAccountId === signatureAccount.accountId) {
      accountStore.currentAccount.signature = signatureAccount.signature
    }
    if (userStore.user?.account?.accountId === signatureAccount.accountId) {
      userStore.user.account.signature = signatureAccount.signature
    }
    signatureShow.value = false
    ElMessage({
      message: t('saveSuccessMsg'),
      type: 'success',
      plain: true,
    })
  }).finally(() => {
    signatureLoading.value = false
  })
}

function pinAccount(item) {
  accountSetAsTop(item.accountId).then(() => {
    ElMessage({
      message: t('setSuccess'),
      type: 'success',
      plain: true,
    })
    loadAccounts()
  })
}

function removeAccount(item) {
  ElMessageBox.confirm(t('delConfirm', {msg: item.email}), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    accountDelete(item.accountId).then(() => {
      const idx = accounts.value.findIndex(a => a.accountId === item.accountId)
      if (idx !== -1) accounts.value.splice(idx, 1)
      ElMessage({
        message: t('delSuccessMsg'),
        type: 'success',
        plain: true,
      })
    })
  })
}

function addAccount() {
  ElMessage({
    message: t('comingSoon'),
    type: 'info',
    plain: true,
  })
}
</script>
<style scoped lang="scss">
.box {
  padding: 40px 40px;

  @media (max-width: 767px) {
    padding: 30px 30px;
  }

  .update-pwd {
    display: flex;
    flex-direction: column;
    gap: 15px;
  }

  .title {
    font-size: 18px;
    font-weight: bold;
  }

  .container {
    font-size: 14px;
    display: grid;
    gap: 20px;
    margin-bottom: 40px;

    .item {
      display: grid;
      grid-template-columns: 50px 1fr;
      gap: 140px;
      position: relative;
      .user-name {
        display: grid;
        grid-template-columns: auto 1fr;
        span:first-child {
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
        }
      }

      .edit-name-input {
        position: absolute;
        bottom: -6px;
        .el-input {
          width: min(200px,calc(100vw - 222px));
        }
      }

      .edit-name {
        color: #4dabff;
        padding-left: 10px;
        cursor: pointer;
      }

      @media (max-width: 767px) {
        gap: 70px;
      }

      div:first-child {
        font-weight: bold;
      }

      div:last-child {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
    }
  }

  .account-title {
    display: flex;
    align-items: center;
    gap: 10px;
    .icon {
      cursor: pointer;
      color: var(--el-color-primary);
    }
  }

  .loading-accounts {
    padding: 10px 0;
  }

  .empty-accounts {
    color: var(--regular-text-color);
    padding: 10px 0;
    text-align: center;
  }

  .account-list {
    display: flex;
    flex-direction: column;
    gap: 8px;

    .account-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 12px;
      border: 1px solid var(--el-border-color-light);
      border-radius: 8px;
      background: var(--el-fill-color-lighter);
      transition: background 0.2s;

      &:hover {
        background: var(--el-fill-color-light);
      }

      .account-email {
        font-size: 14px;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;

        .account-name {
          color: var(--el-text-color-secondary);
          margin-left: 6px;
          font-size: 12px;
        }
      }

      .account-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
        align-items: center;
      }
    }
  }

  .del-email {
    font-size: 14px;
    display: flex;
    flex-direction: column;
    gap: 20px;
  }
}

.signature-editor {
  height: 380px;
}

.signature-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>

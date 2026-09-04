<template>
  <div class="send" v-show="show">
    <div class="write-box">
      <div class="title">
        <div class="title-left">
          <span class="title-text">
            <Icon icon="hugeicons:quill-write-01" width="28" height="28"/>
          </span>
          <span class="sender">{{ $t('sender') }}:</span>
          <el-select
              class="sender-select"
              v-model="form.accountId"
              :aria-label="$t('sender')"
              @change="changeSender"
          >
            <el-option
                v-for="item in senderOptions"
                :key="item.accountId"
                :label="`${item.name || item.email} <${item.email}>`"
                :value="item.accountId"
            />
          </el-select>
        </div>
        <div @click="close" style="cursor: pointer;">
          <Icon icon="material-symbols-light:close-rounded" width="22" height="22"/>
        </div>
      </div>
      <div class="container">
        <div class="recipient-fields">
          <recipientInput
              v-model="form.receiveEmail"
              :label="$t('recipient')"
              :suggestions="selectRecipientList.to"
              @activate="setActiveRecipientRole('to')"
              @add-tag="addTagChange('to', $event)"
              @input="inputChange('to', $event)"
              @suggestion="selectChange('to', $event)"
              @contacts="openContacts('to')"
          />
          <div v-if="!showCc || !showBcc" class="recipient-disclosure">
            <el-button v-if="!showCc" text size="small" @click="showRecipientRole('cc')">{{ $t('cc') }}</el-button>
            <el-button v-if="!showBcc" text size="small" @click="showRecipientRole('bcc')">{{ $t('bcc') }}</el-button>
          </div>
          <recipientInput
              v-if="showCc"
              v-model="form.cc"
              :label="$t('cc')"
              :suggestions="selectRecipientList.cc"
              @activate="setActiveRecipientRole('cc')"
              @add-tag="addTagChange('cc', $event)"
              @input="inputChange('cc', $event)"
              @suggestion="selectChange('cc', $event)"
              @contacts="openContacts('cc')"
          />
          <recipientInput
              v-if="showBcc"
              v-model="form.bcc"
              :label="$t('bcc')"
              :suggestions="selectRecipientList.bcc"
              @activate="setActiveRecipientRole('bcc')"
              @add-tag="addTagChange('bcc', $event)"
              @input="inputChange('bcc', $event)"
              @suggestion="selectChange('bcc', $event)"
              @contacts="openContacts('bcc')"
          />
        </div>
        <el-input v-model="form.subject" :placeholder="t('subject')" />
        <tinyEditor :def-value="defValue" ref="editor" @change="change" />
        <div class="button-item">
          <div class="att-add" @click="chooseFile">
            <Icon icon="iconamoon:attachment-fill" width="24" height="24"/>
          </div>
          <div class="att-clear" @click="clearContent">
            <Icon icon="icon-park-outline:clear-format" width="24" height="24 "/>
          </div>
          <div class="att-list">
            <div class="att-item" v-for="(item,index) in form.attachments" :key="index">
              <Icon v-bind="getIconByName(item.filename)"/>
              <span class="att-filename">{{ item.filename }}</span>
              <span class="att-size">{{ formatBytes(item.size) }}</span>
              <Icon style="cursor: pointer;" icon="material-symbols-light:close-rounded" @click="delAtt(index)"
                    width="22" height="22"/>
            </div>
          </div>
          <div>
            <el-button type="primary" @click="sendEmail" v-if="form.sendType === 'reply'">{{ $t('reply') }}</el-button>
            <el-button type="primary" @click="sendEmail" v-else-if="form.sendType === 'forward'">{{ $t('forward') }}</el-button>
            <el-button type="primary" @click="sendEmail" v-else>{{ $t('send') }}</el-button>
          </div>
        </div>
      </div>
    </div>
    <el-dialog top="10vh" v-model="showContacts" @closed="clearSelectContact" :title="t('recentContacts')">
      <el-table ref="contactsTabRef" row-key="email" :data="contacts" style="height: 445px">
        <el-table-column type="selection" width="32" />
        <el-table-column property="email" :label="t('emailAccount')" >
          <template #default="props">
            <div class="email-row">{{ props.row.email }}</div>
          </template>
        </el-table-column>
        <el-table-column width="55" label="" >
          <template #default>
            <div style="display: flex;">
              <Icon icon="mage:user" style="color: var(--el-text-color-primary)" width="22" height="22" color="#606266" />
            </div>
          </template>
        </el-table-column>
      </el-table>
      <div class="contacts-bottom">
        <el-button type="default" @click="deleteContact">{{t('clear')}}</el-button>
        <el-button type="primary" @click="chooseContact">{{t('selectContacts')}}</el-button>
      </div>
    </el-dialog>
  </div>
</template>
<script setup>
import tinyEditor from '@/components/tiny-editor/index.vue'
import recipientInput from '@/components/recipient-input/index.vue'
import {h, nextTick, onMounted, onUnmounted, reactive, ref, toRaw, computed} from "vue";
import {Icon} from "@iconify/vue";
import {useUserStore} from "@/store/user.js";
import {emailSend} from "@/request/email.js";
import {normalizeRecipientGroups} from "@/utils/recipient-utils.js";
import {useAccountStore} from "@/store/account.js";
import {useEmailStore} from "@/store/email.js";
import {fileToBase64, formatBytes} from "@/utils/file-utils.js";
import {getIconByName} from "@/utils/icon-utils.js";
import sendPercent from "@/components/send-percent/index.vue"
import {toOssDomain} from "@/utils/convert.js";
import {formatDetailDate} from "@/utils/day.js";
import {useSettingStore} from "@/store/setting.js";
import {userDraftStore} from "@/store/draft.js";
import {useWriterStore} from "@/store/writer.js";
import db from "@/db/db.js";
import dayjs from "dayjs";
import {useI18n} from "vue-i18n";
import router from "@/router/index.js";
import {ElMessageBox} from "element-plus";

defineExpose({
  open,
  openReply,
  openReplyAll,
  openForward,
  openDraft
})

const {t} = useI18n()
const writerStore = useWriterStore();
const draftStore = userDraftStore()
const settingStore = useSettingStore()
const emailStore = useEmailStore();
const accountStore = useAccountStore()
const editor = ref({})
const userStore = useUserStore();
const show = ref(false);
const percent = ref(0)
let percentMessage = null
let sending = false
const defValue = ref('')
const contactsTabRef = ref({})
const showContacts = ref(false)
const activeRecipientRole = ref('to')
const showCc = ref(false)
const showBcc = ref(false)
const backReply = reactive({
  receiveEmail: [],
  cc: [],
  bcc: [],
  subject: '',
  content: '',
  sendType: ''
})
const form = reactive({
  sendEmail: '',
  receiveEmail: [],
  cc: [],
  bcc: [],
  accountId: -1,
  name: '',
  subject: '',
  content: '',
  sendType: '',
  text: '',
  emailId: 0,
  attachments: [],
  draftId: null,
})

const selectRecipientList = reactive({to: [], cc: [], bcc: []})
const SIGNATURE_CLASS = 'cloud-mail-auto-signature'
const signatureState = reactive({
  accountId: null,
  insertedSignature: null
})

const contacts = computed(() => writerStore.sendRecipientRecord.map(item => ({email: item})))
const senderOptions = computed(() => {
  const options = []
  const seen = new Set()

  const addOption = (item) => {
    if (!item?.accountId || seen.has(item.accountId)) return
    seen.add(item.accountId)
    options.push({
      accountId: item.accountId,
      email: item.email,
      name: item.name || item.email,
      signature: item.signature || null
    })
  }

  addOption(userStore.user?.account ? {
    ...userStore.user.account,
    email: userStore.user.email,
    name: userStore.user.name,
  } : null)
  accountStore.accounts.forEach(addOption)
  addOption(accountStore.currentAccount)

  return options
})

function recipientList(role) {
  return role === 'to' ? form.receiveEmail : form[role]
}

function setActiveRecipientRole(role) {
  activeRecipientRole.value = role
}

function showRecipientRole(role) {
  if (role === 'cc') showCc.value = true
  if (role === 'bcc') showBcc.value = true
  setActiveRecipientRole(role)
}

function openContacts(role = activeRecipientRole.value) {
  setActiveRecipientRole(role)
  showContacts.value = true
  nextTick(() => {
    recipientList(role).forEach(item => {
      if (writerStore.sendRecipientRecord.includes(item)) {
        contactsTabRef.value.toggleRowSelection({email: item});
      }
    })
  })
}

function deleteContact() {
  ElMessageBox.confirm(t('confirmDeletionOfContacts'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
    const recipients = recipientList(activeRecipientRole.value)
    const retained = recipients.filter(item => !contactList.includes(item))
    if (activeRecipientRole.value === 'to') form.receiveEmail = retained
    else form[activeRecipientRole.value] = retained
    writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(item => !contactList.includes(item));
  })
}

function chooseContact() {
  const contactList = contactsTabRef.value.getSelectionRows().map(item => item.email);
  const recipients = recipientList(activeRecipientRole.value)
  contactList.forEach(item => {
    if (!recipients.some(recipient => recipient.toLowerCase() === item.toLowerCase())) {
      recipients.push(item);
    }
  })
  showContacts.value = false
}

function clearSelectContact() {
  contactsTabRef.value?.clearSelection?.();
}

function selectChange(role, value) {
  const recipients = recipientList(role)
  if (!recipients.some(item => item.toLowerCase() === value.toLowerCase())) {
    recipients.push(value)
  }
}

function inputChange(role, value) {
  const input = String(value || '').toLowerCase()
  selectRecipientList[role] = writerStore.sendRecipientRecord
      .filter(item => input && !recipientList(role).some(recipient => recipient.toLowerCase() === item.toLowerCase()) && item.toLowerCase().startsWith(input))
      .slice(0, 10)
}

function addTagChange(role, value) {
  const recipients = recipientList(role)
  if (recipients.at(-1) === value) recipients.pop()
  for (const address of String(value).split(/[,，]/).map(item => item.trim()).filter(Boolean)) {
    if (!recipients.some(item => item.toLowerCase() === address.toLowerCase())) {
      recipients.push(address)
    }
  }
}

function clearContent() {
  ElMessageBox.confirm(t('clearContentConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning'
  }).then(() => {
    resetForm()
  })

}

function delAtt(index) {
  form.attachments.splice(index, 1);
}

function chooseFile() {
  const doc = document.createElement("input")
  doc.setAttribute("type", "file")
  doc.multiple = true;
  doc.click()
  doc.onchange = async (e) => {

    const fileList = e.target.files;

    for (const file of fileList) {

      const size = file.size
      const filename = file.name
      const contentType = file.type

      const content = await fileToBase64(file)
      form.attachments.push({content, filename, size, contentType})

    }

  }
}

async function sendEmail() {
  const recipients = normalizeRecipientGroups(form)
  if (recipients.errors.length > 0) {
    const errorType = recipients.errors[0].type
    ElMessage({
      message: errorType === 'empty'
          ? t('emptyRecipientMsg')
          : errorType === 'duplicate'
              ? t('recipientDuplicateMsg')
              : t('invalidRecipientMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  form.receiveEmail = recipients.to
  form.cc = recipients.cc
  form.bcc = recipients.bcc

  if (!form.subject) {
    ElMessage({
      message: t('emptySubjectMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  form.content = stripSignatureMarkers(editor.value.getContent());

  if (!form.content) {
    ElMessage({
      message: t('emptyContentMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (form.manyType === 'divide' && form.attachments.length > 0) {
    ElMessage({
      message: t('noSeparateSendMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  if (sending) {
    ElMessage({
      message: t('sendingErrorMsg'),
      type: 'error',
      plain: true,
    })
    return
  }

  percentMessage = ElMessage({
    message: () => h(sendPercent, {value: percent.value, desc: t('sending')}),
    dangerouslyUseHTMLString: true,
    plain: true,
    duration: 0,
    customClass: 'message-bottom'
  })

  sending = true

  show.value = false

  emailSend(form, (e) => {
    percent.value = Math.round((e.loaded * 98) / e.total)
  }).then(emailList => {
    const email = emailList[0]
    emailList.forEach(item => {
      emailStore.sendScroll?.addItem(item)
    })

    ElNotification({
      title: t('sendSuccessMsg'),
      type: "success",
      message: h('span', {style: 'color: teal'}, email.subject),
      position: 'bottom-right'
    })

    userStore.refreshUserInfo();

    addRecipientRecord();

    if (form.draftId) {
      form.subject = ''
      form.content = ''
      form.receiveEmail = []
      form.cc = []
      form.bcc = []
      draftStore.setDraft = {...toRaw(form)}
    }

    show.value = false
    resetForm();
  }).catch((e) => {
    ElNotification({
      title: t('sendFailMsg'),
      type: e.code === 403 ? 'warning' : 'error',
      message: h('span', {style: 'color: teal'}, e.message),
      position: 'bottom-right'
    })
    if (e.code === 401) {
      localStorage.removeItem('token');
      router.replace('/login');
    }
    show.value = true
    addRecipientRecord();
  }).finally(() => {
    percentMessage.close()
    percent.value = 0
    sending = false
  })
}

function addRecipientRecord() {
  const recipients = [...form.receiveEmail, ...form.cc, ...form.bcc]
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.filter(
      email => !recipients.some(recipient => recipient.toLowerCase() === email.toLowerCase())
  );

  writerStore.sendRecipientRecord.unshift(...recipients);
  writerStore.sendRecipientRecord = writerStore.sendRecipientRecord.slice(0, 500);
}

function snapshotReply() {
  backReply.content = editor.value.getContent()
  backReply.subject = form.subject
  backReply.receiveEmail = [...form.receiveEmail]
  backReply.cc = [...form.cc]
  backReply.bcc = [...form.bcc]
  backReply.sendType = form.sendType
}

function hasSameRecipients() {
  return ['receiveEmail', 'cc', 'bcc'].every(field => {
    const current = field === 'receiveEmail' ? form.receiveEmail : form[field]
    const saved = backReply[field]
    return current.length === saved.length && current.every((recipient, index) => recipient === saved[index])
  })
}

function resetForm() {
  form.receiveEmail = []
  form.cc = []
  form.bcc = []
  form.subject = ''
  form.content = ''
  defValue.value = ''
  form.manyType = null
  form.attachments = []
  form.sendType = ''
  form.emailId = 0
  form.draftId = null
  backReply.content = ''
  backReply.subject = ''
  backReply.receiveEmail = []
  backReply.cc = []
  backReply.bcc = []
  backReply.sendType = ''
  showCc.value = false
  showBcc.value = false
  activeRecipientRole.value = 'to'
  resetSignatureState()
  editor.value.clearEditor()
}

function change(content, text) {
  form.content = content;
  form.text = text
}

function openForward(email) {
  resetForm();

  email.subject = email.subject || ''

  form.subject = email.subject
  form.sendType = 'forward'

  defValue.value = ''

  setTimeout(() => {
    defValue.value = withSignature(`
      ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
    `)
    open()

    nextTick(() => {
      snapshotReply()
    })

  });
}

function openReply(email) {
  openReplyWithRecipients(email, {to: [email.sendEmail], cc: [], bcc: []})
}

function openReplyAll(email, recipients) {
  openReplyWithRecipients(email, recipients)
}

function openReplyWithRecipients(email, recipients) {
  resetForm();

  email.subject = email.subject || ''

  form.receiveEmail = [...(recipients?.to || [])]
  form.cc = [...(recipients?.cc || [])]
  form.bcc = []
  showCc.value = form.cc.length > 0
  form.subject = (
      email.subject.startsWith('Re:') ||
      email.subject.startsWith('Re：') ||
      email.subject.startsWith('回复：') ||
      email.subject.startsWith('回复:')) ? email.subject : 'Re: ' + email.subject
  form.sendType = 'reply'
  form.emailId = email.emailId

  defValue.value = ''

  setTimeout(() => {
    defValue.value = withSignature(`
    <div>
    <br>
        ${formatDetailDate(email.createTime)} ${email.name} &lt${email.sendEmail}&gt ${t('wrote')}:
    </div>
    <blockquote class="mceNonEditable" style="margin: 0 0 0 0.8ex;border-left: 1px solid rgb(204,204,204);padding-left: 1ex;">
      <articl>
          ${formatImage(email.content) || `<pre style="font-family: inherit;word-break: break-word;white-space: pre-wrap;margin: 0">${email.text}</pre>`}
      </article>
    </blockquote>`)
    open()

    nextTick(() => {
      snapshotReply()
    })
  })

}

function formatImage(content) {
  content = content || '';
  const domain = settingStore.settings.r2Domain;
  return content.replace(/{{domain}}/g, toOssDomain(domain) + '/');
}

function open() {
  applySender(getDefaultSender(), false)
  if (!defValue.value && !form.content) {
    defValue.value = withSignature('')
  }
  show.value = true;
  editor.value.focus()
}

function openDraft(draft) {
  Object.assign(form, {...draft})
  form.receiveEmail = Array.isArray(draft.receiveEmail) ? draft.receiveEmail : []
  form.cc = Array.isArray(draft.cc) ? draft.cc : []
  form.bcc = Array.isArray(draft.bcc) ? draft.bcc : []
  showCc.value = form.cc.length > 0
  showBcc.value = form.bcc.length > 0
  resetSignatureState()
  defValue.value = ''
  setTimeout(() => defValue.value = form.content)
  show.value = true;
  editor.value.focus()
}

const handleKeyDown = (event) => {
  if (event.key === 'Escape') {
    close()
  }
};

onMounted(() => {
  window.addEventListener('keydown', handleKeyDown);
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeyDown);
});

function close() {
  if (!form.content) {
    form.content = editor.value.getContent();
  }

  if (form.draftId) {
    form.content = stripSignatureMarkers(form.content);
    draftStore.setDraft = {...toRaw(form)}
    show.value = false
    resetForm()
    return;
  }

  if (!(form.content || form.subject || form.receiveEmail.length > 0 || form.cc.length > 0 || form.bcc.length > 0)) {
    show.value = false
    resetForm()
    return;
  }

  if (backReply.sendType === 'reply' || backReply.sendType === 'forward') {
    let subjectFlag = form.subject === backReply.subject
    let contentFlag = editor.value.getContent() === backReply.content
    if (subjectFlag && contentFlag && hasSameRecipients()) {
      resetForm();
      show.value = false
      return;
    }
  }

  ElMessageBox.confirm(t('saveDraftConfirm'), {
    confirmButtonText: t('confirm'),
    cancelButtonText: t('cancel'),
    type: 'warning',
    distinguishCancelAndClose: true
  }).then(async () => {
    form.content = stripSignatureMarkers(editor.value.getContent());
    const formData = {...toRaw(form)};
    delete formData.draftId
    delete formData.attachments
    formData.createTime = dayjs().utc().format('YYYY-MM-DD HH:mm:ss');
    const draftId = await db.value.draft.add({...formData})
    db.value.att.add({draftId, attachments: toRaw(form.attachments)})
    draftStore.refreshList++
    show.value = false
    await nextTick(() => {
      resetForm()
    })
  }).catch((action) => {
    if (action === 'cancel') {
      show.value = false
      resetForm()
    }
  })

}

function getDefaultSender() {
  if (accountStore.currentAccount?.email) {
    return accountStore.currentAccount
  }

  return {
    ...userStore.user.account,
    email: userStore.user.email,
    name: userStore.user.name,
  }
}

function findSender(accountId) {
  return senderOptions.value.find(item => item.accountId === accountId) || getDefaultSender()
}

function applySender(account, updateSignature = true) {
  form.sendEmail = account.email;
  form.accountId = account.accountId;
  form.name = account.name || account.email;

  if (updateSignature) {
    replaceSignature(account)
  }
}

function normalizeSignature(signature) {
  return signature?.trim() || null
}

function resetSignatureState() {
  signatureState.accountId = null
  signatureState.insertedSignature = null
}

function buildSignatureBlock(signature) {
  return `<div class="${SIGNATURE_CLASS}">${signature}</div>`
}

function getDocumentBody(html) {
  const doc = new DOMParser().parseFromString(`<body>${html || ''}</body>`, 'text/html')
  return doc.body
}

function getSignatureNode(body) {
  return body.querySelector(`.${SIGNATURE_CLASS}`)
}

function stripSignatureMarkers(html) {
  const body = getDocumentBody(html)
  body.querySelectorAll(`.${SIGNATURE_CLASS}`).forEach(node => {
    node.classList.remove(SIGNATURE_CLASS)
    if (!node.getAttribute('class')) {
      node.removeAttribute('class')
    }
  })
  return body.innerHTML
}

function withSignature(content) {
  const signature = normalizeSignature(findSender(form.accountId)?.signature || getDefaultSender()?.signature)

  if (!signature) {
    resetSignatureState()
    return content
  }

  signatureState.accountId = form.accountId
  signatureState.insertedSignature = signature
  return `<div><br></div>${buildSignatureBlock(signature)}${content || ''}`
}

function replaceSignature(account) {
  const nextSignature = normalizeSignature(account.signature)
  const currentContent = editor.value?.getContent?.() || form.content || ''
  const body = getDocumentBody(currentContent)
  const signatureNode = getSignatureNode(body)

  if (!signatureState.insertedSignature || !signatureNode) {
    if (!nextSignature) return
    const nextContent = `<div><br></div>${buildSignatureBlock(nextSignature)}${stripSignatureMarkers(currentContent)}`
    setEditorContent(nextContent)
    signatureState.accountId = account.accountId
    signatureState.insertedSignature = nextSignature
    return
  }

  if (normalizeSignature(signatureNode.innerHTML) !== signatureState.insertedSignature) {
    return
  }

  if (nextSignature) {
    signatureNode.innerHTML = nextSignature
  } else {
    signatureNode.remove()
  }

  setEditorContent(body.innerHTML)
  signatureState.accountId = account.accountId
  signatureState.insertedSignature = nextSignature
}

function setEditorContent(content) {
  form.content = content
  defValue.value = content
  editor.value?.setContent?.(content)
}

function changeSender(accountId) {
  applySender(findSender(accountId), true)
}

</script>
<style scoped lang="scss">
.send {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;

  .write-box {
    background: var(--el-bg-color);
    width: min(1367px, calc(100% - 80px));
    box-shadow: var(--el-box-shadow-light);
    border: 1px solid var(--el-border-color-light);
    transition: var(--el-transition-duration);
    padding: 15px;
    border-radius: 8px;
    display: grid;
    grid-template-rows: auto 1fr;
    overflow: hidden;
    @media (max-width: 1024px) {
      width: 100%;
      height: 100%;
      border-radius: 0;
      border: 0;
      padding-top: 10px;
    }

    @media (min-width: 1025px) {
      height: min(800px, calc(100vh - 60px));
    }

    .title {
      display: flex;
      justify-content: space-between;
      margin-bottom: 10px;

      .title-left {
        align-items: center;
        display: grid;
        grid-template-columns: auto auto minmax(180px, 420px);
      }

      .title-text {
      }

      .sender {
        margin-left: 8px;
      }

      .sender-select {
        margin-left: 8px;
        min-width: 0;
      }


      div {
        display: flex;
        align-items: center;
      }
    }

    .container {
      height: 100%;
      display: grid;
      grid-template-rows: auto auto 1fr auto;
      gap: 15px;

      .recipient-fields {
        display: grid;
        gap: 8px;
      }

      .recipient-disclosure {
        display: flex;
        gap: 6px;
        justify-content: flex-end;
      }

      .button-item {
        display: grid;
        grid-template-columns: auto auto 1fr auto;

        .att-add {
          cursor: pointer;
        }

        .att-clear {
          cursor: pointer;
          margin-left: 10px;
        }

        .att-list {
          display: grid;
          gap: 5px;
          grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
          padding-left: 10px;
          padding-right: 10px;
          max-height: 110px;
          overflow-y: auto;
          @media (max-width: 450px) {
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
          }

          .att-item {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            gap: 5px;
            height: 32px;
            font-size: 14px;
            padding: 4px 5px;
            background: var(--light-ill);
            border-radius: 4px;
            .att-filename {
              white-space: nowrap;
              text-overflow: ellipsis;
              overflow: hidden;
            }
          }
        }
      }
    }
  }

}

.email-row {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

:deep(.el-dialog) {
  width: 420px !important;
  @media (max-width: 460px) {
    width: calc(100% - 40px) !important;
    margin-right: 20px !important;
    margin-left: 20px !important;
  }
}

.contacts-bottom {
  display: flex;
  justify-content: end;
  margin-top: 10px;
}

:deep(.el-input-tag__suffix) {
  padding-right: 4px;
}

.icon {
  cursor: pointer;
}
</style>

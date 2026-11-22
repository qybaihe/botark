package com.qybaihe.botark

import android.content.Intent
import android.graphics.Color as AndroidColor
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.ChatBubble
import androidx.compose.material.icons.rounded.Sensors
import androidx.compose.material.icons.rounded.VerifiedUser
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.qybaihe.botark.model.PlatformId
import com.qybaihe.botark.ui.screens.AddBotPickerSheet
import com.qybaihe.botark.ui.screens.AddHermesDialog
import com.qybaihe.botark.ui.screens.AddStandaloneWebBotSheet
import com.qybaihe.botark.ui.screens.ApprovalsScreen
import com.qybaihe.botark.ui.screens.BotListScreen
import com.qybaihe.botark.ui.screens.ChatScreen
import com.qybaihe.botark.ui.screens.QRScannerSheet
import com.qybaihe.botark.ui.screens.StandaloneWebScreen
import com.qybaihe.botark.ui.screens.SyncSettingsScreen
import com.qybaihe.botark.ui.theme.ArkColors
import com.qybaihe.botark.ui.theme.ArkMonoFamily
import com.qybaihe.botark.ui.theme.ArkSansFamily
import com.qybaihe.botark.ui.theme.BotArkTheme
import com.qybaihe.botark.viewmodel.BotArkViewModel

enum class MainTab(val label: String, val icon: ImageVector) {
    CHATS("对话", Icons.Rounded.ChatBubble),
    APPROVALS("审批", Icons.Rounded.VerifiedUser),
    SYNC("同步", Icons.Rounded.Sensors)
}

class MainActivity : ComponentActivity() {
    private val viewModel: BotArkViewModel by viewModels()

    private val initialTabState = mutableStateOf(MainTab.CHATS)
    private val initialOpenBotState = mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(AndroidColor.TRANSPARENT, AndroidColor.TRANSPARENT)
        )
        handleIncomingIntent(intent)

        setContent {
            BotArkTheme {
                BotArkRoot(
                    viewModel = viewModel,
                    initialTab = initialTabState.value,
                    initialOpenBotId = initialOpenBotState.value
                )
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun handleIncomingIntent(intent: Intent?) {
        if (intent == null) return
        val data = intent.data
        if (data != null && data.scheme.equals("botark", ignoreCase = true)) {
            viewModel.pair(data.toString())
        }
        if (BuildConfig.DEBUG) {
            intent.getStringExtra("pair_uri")?.takeIf { it.isNotBlank() }?.let { uri ->
                viewModel.pair(uri)
            }
            when (intent.getStringExtra("open_tab")) {
                "approvals" -> {
                    initialOpenBotState.value = null
                    initialTabState.value = MainTab.APPROVALS
                }
                "sync" -> {
                    initialOpenBotState.value = null
                    initialTabState.value = MainTab.SYNC
                }
                "chats" -> {
                    initialOpenBotState.value = null
                    initialTabState.value = MainTab.CHATS
                }
            }
            intent.getStringExtra("open_bot")?.takeIf { it.isNotBlank() }?.let { botId ->
                initialTabState.value = MainTab.CHATS
                initialOpenBotState.value = botId
            }
        }
    }
}

@Composable
private fun BotArkRoot(
    viewModel: BotArkViewModel,
    initialTab: MainTab,
    initialOpenBotId: String?
) {
    val palette = ArkColors.current
    val state by viewModel.uiState.collectAsState()
    val commandSnackbar = remember { SnackbarHostState() }

    var currentTab by remember { mutableStateOf(initialTab) }
    var activeBotId by remember { mutableStateOf(initialOpenBotId) }
    var showScanner by remember { mutableStateOf(false) }
    var showAddHermes by remember { mutableStateOf(false) }
    var showAddPicker by remember { mutableStateOf(false) }
    var pendingWebPlatform by remember { mutableStateOf<PlatformId?>(null) }

    val handlePickPlatform: (PlatformId) -> Unit = { platform ->
        if (platform == PlatformId.HERMES) {
            showAddHermes = true
        } else {
            pendingWebPlatform = platform
        }
    }

    LaunchedEffect(initialTab) { currentTab = initialTab }
    LaunchedEffect(initialOpenBotId) { activeBotId = initialOpenBotId }
    LaunchedEffect(viewModel) {
        viewModel.commandErrors.collect { commandSnackbar.showSnackbar(it) }
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(palette.canvas)
            .statusBarsPadding()
            .navigationBarsPadding()
    ) {
        if (activeBotId != null && currentTab == MainTab.CHATS) {
            val activeBot = state.snapshot.bots.firstOrNull { it.id == activeBotId }
            if (activeBot?.isStandaloneWeb == true) {
                StandaloneWebScreen(
                    state = state,
                    botId = activeBotId!!,
                    onBack = { activeBotId = null },
                    onRemoveBot = { viewModel.removeStandaloneBot(it) }
                )
            } else {
                ChatScreen(
                    state = state,
                    botId = activeBotId!!,
                    onBack = { activeBotId = null },
                    onSend = { bot, text -> viewModel.sendMessage(bot, text) },
                    onStop = { bot -> viewModel.stopGeneration(bot) },
                    onNewSession = { bot -> viewModel.startNewSession(bot) },
                    onDecideApproval = { item, dec -> viewModel.decideApproval(item, dec) }
                )
            }
        } else {
            when (currentTab) {
                MainTab.CHATS -> BotListScreen(
                    state = state,
                    onOpenBot = { activeBotId = it },
                    onOpenScanner = { showScanner = true },
                    onOpenAddPicker = { showAddPicker = true },
                    onPickPlatform = handlePickPlatform,
                    onReconnect = { viewModel.reconnectDesktop() }
                )
                MainTab.APPROVALS -> ApprovalsScreen(
                    state = state,
                    onDecide = { item, dec -> viewModel.decideApproval(item, dec) }
                )
                MainTab.SYNC -> SyncSettingsScreen(
                    state = state,
                    onOpenScanner = { showScanner = true },
                    onReconnect = { viewModel.reconnectDesktop() },
                    onUnpair = { viewModel.unpairDesktop() },
                    onOpenAddHermes = { showAddHermes = true },
                    onImportBundle = { bytes, key -> viewModel.importOfflineBundle(bytes, key) },
                    onWipeAll = { viewModel.wipeAllLocalData() }
                )
            }
        }

        // Signature Floating Obsidian Capsule Dock (smoothly hides inside Chat/Web for edge-to-edge immersion!)
        AnimatedVisibility(
            visible = activeBotId == null,
            enter = fadeIn() + slideInVertically { it / 2 },
            exit = fadeOut() + slideOutVertically { it / 2 },
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .padding(bottom = 12.dp)
        ) {
            FloatingObsidianDock(
                currentTab = currentTab,
                pendingApprovals = state.pendingApprovals.size,
                onSelect = { tab ->
                    activeBotId = null
                    currentTab = tab
                }
            )
        }
        SnackbarHost(
            hostState = commandSnackbar,
            modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = if (activeBotId == null) 72.dp else 0.dp)
        )
    }

    if (showScanner) {
        QRScannerSheet(
            pairingBusy = state.pairingBusy,
            lastError = state.lastError,
            onPair = { uri ->
                viewModel.pair(uri) { showScanner = false }
            },
            onDismiss = { showScanner = false }
        )
    }

    if (showAddHermes) {
        AddHermesDialog(
            onAdd = { name, url, key, model ->
                viewModel.addStandaloneHermes(name, url, key, model)
            },
            onDismiss = { showAddHermes = false }
        )
    }

    if (showAddPicker) {
        AddBotPickerSheet(
            onPickPlatform = handlePickPlatform,
            onOpenScanner = { showScanner = true },
            onDismiss = { showAddPicker = false }
        )
    }

    pendingWebPlatform?.let { platform ->
        AddStandaloneWebBotSheet(
            platform = platform,
            onCreate = { name ->
                val created = viewModel.addStandaloneWebBot(platformId = platform, name = name)
                currentTab = MainTab.CHATS
                activeBotId = created.id
            },
            onSwitchToQR = { showScanner = true },
            onDismiss = { pendingWebPlatform = null }
        )
    }
}

@Composable
private fun FloatingObsidianDock(
    currentTab: MainTab,
    pendingApprovals: Int,
    onSelect: (MainTab) -> Unit
) {
    val palette = ArkColors.current

    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .shadow(18.dp, CircleShape, ambientColor = Color.Black.copy(alpha = 0.28f))
            .clip(CircleShape)
            .background(palette.obsidian.copy(alpha = 0.96f))
            .border(0.8.dp, Color.White.copy(alpha = 0.11f), CircleShape)
            .padding(5.dp)
    ) {
        MainTab.entries.forEach { tab ->
            val active = currentTab == tab
            val badge = if (tab == MainTab.APPROVALS) pendingApprovals else 0

            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier
                    .height(40.dp)
                    .clip(CircleShape)
                    .background(if (active) palette.porcelain else Color.Transparent)
                    .clickable { onSelect(tab) }
                    .padding(horizontal = if (active) 16.dp else 14.dp)
            ) {
                Box(contentAlignment = Alignment.TopEnd) {
                    Icon(
                        imageVector = tab.icon,
                        contentDescription = tab.label,
                        tint = if (active) palette.obsidian else Color.White.copy(alpha = 0.68f),
                        modifier = Modifier.size(16.dp)
                    )
                    if (badge > 0) {
                        Box(
                            contentAlignment = Alignment.Center,
                            modifier = Modifier
                                .offset(x = 7.dp, y = (-5).dp)
                                .size(14.dp)
                                .clip(CircleShape)
                                .background(palette.amber)
                        ) {
                            Text(
                                text = if (badge > 9) "9+" else badge.toString(),
                                fontSize = 8.5.sp,
                                fontFamily = ArkMonoFamily,
                                fontWeight = FontWeight.Bold,
                                color = Color.White
                            )
                        }
                    }
                }
                if (active) {
                    Text(
                        text = tab.label,
                        fontSize = 12.5.sp,
                        fontFamily = ArkSansFamily,
                        fontWeight = FontWeight.SemiBold,
                        color = palette.obsidian,
                        maxLines = 1
                    )
                }
            }
        }
    }
}

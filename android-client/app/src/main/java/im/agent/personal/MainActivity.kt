package im.agent.link

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ApplicationInfo
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ElevatedCard
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.ClipboardManager
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.core.content.ContextCompat
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private const val debugProbeTag = "AgentImDebugProbe"
private const val debugProbeEnabledKey = "debug_probe_enabled"
private const val debugProbeAgentIdKey = "debug_probe_agent_id"
private const val debugProbeCommandKey = "debug_probe_command"
private const val debugProbeTextKey = "debug_probe_text"
private const val debugProbeDelayMsKey = "debug_probe_delay_ms"
private const val debugHubOriginKey = "debug_hub_origin"

private val appGradient = Brush.verticalGradient(
    colors = listOf(
        Color(0xFF121824),
        Color(0xFF192130),
        Color(0xFF202938)
    )
)

private val inboxCardGradient = Brush.horizontalGradient(
    colors = listOf(
        Color(0xFF2B3442),
        Color(0xFF222A36)
    )
)

private data class ConversationCardState(
    val agent: AgentSnapshot,
    val lastMessageAt: String,
    val preview: String?
)

private data class ConversationRuntimeState(
    val contextUsedTokens: Int? = null,
    val contextWindowTokens: Int? = null
)

private data class TuiComposerState(
    val prompt: String,
    val keyHints: List<String> = emptyList()
)

data class DebugCommandProbe(
    val agentId: String?,
    val command: String,
    val text: String?,
    val delayMs: Long
)

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<MainViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val isDebuggableBuild = isDebuggableBuild()
        handleLaunchIntent(intent, isDebuggableBuild)

        setContent {
            AgentImTheme {
                RequestNotificationPermission()
                val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { viewModel.load() }
                AppContent(
                    state = uiState,
                    resolveArtifactUrl = viewModel::resolveArtifactUrl,
                    onHubOriginChange = viewModel::updateHubOrigin,
                    onConnect = viewModel::connect,
                    onSelectAgent = viewModel::selectAgent,
                    onBackToInbox = { viewModel.selectAgent(null) },
                    onCreateSession = viewModel::createSession,
                    onDeleteSession = viewModel::deleteSession,
                    onQuickCommand = viewModel::sendQuickCommand,
                    onSendInstruction = viewModel::sendInstruction,
                    onSendSpecialKey = viewModel::sendSpecialKey,
                    onSelectTuiMenuItem = viewModel::selectTuiMenuItem,
                    onDismissTuiMenu = viewModel::dismissTuiMenu
                )
            }
        }

        val debugProbe = readDebugCommandProbe(intent, isDebuggableBuild)
        if (debugProbe != null) {
            lifecycleScope.launch {
                runDebugProbe(debugProbe)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        viewModel.refreshFromHub()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleLaunchIntent(intent, isDebuggableBuild())
    }

    private suspend fun runDebugProbe(debugProbe: DebugCommandProbe) {
        repeat(30) {
            val state = viewModel.uiState.value
            val targetAgent = if (debugProbe.agentId.isNullOrBlank()) {
                state.agents.firstOrNull()
            } else {
                state.agents.firstOrNull { it.agentId == debugProbe.agentId }
            }

            if (state.socketState == SocketConnectionState.CONNECTED && targetAgent != null) {
                viewModel.selectAgent(targetAgent.agentId)
                delay(debugProbe.delayMs)
                Log.i(
                    debugProbeTag,
                    "Triggering debug probe command ${debugProbe.command} for ${targetAgent.agentId}"
                )
                if (debugProbe.command == "send_text") {
                    viewModel.sendInstruction(targetAgent.agentId, debugProbe.text.orEmpty())
                } else {
                    viewModel.sendQuickCommand(targetAgent.agentId, debugProbe.command)
                }
                return
            }

            delay(500)
        }

        Log.w(debugProbeTag, "Debug probe timed out before agent became ready")
    }

    private fun handleLaunchIntent(intent: Intent?, isDebuggableBuild: Boolean) {
        readDebugHubOrigin(intent, isDebuggableBuild)?.let(viewModel::updateHubOrigin)
        readOpenAgentId(intent)?.let {
            viewModel.selectAgent(it)
            viewModel.refreshFromHub()
        }
    }
}

@Composable
private fun RequestNotificationPermission() {
    val context = LocalContext.current
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        return
    }

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { }

    LaunchedEffect(Unit) {
        val granted = ContextCompat.checkSelfPermission(
            context,
            Manifest.permission.POST_NOTIFICATIONS
        ) == PackageManager.PERMISSION_GRANTED
        if (!granted) {
            launcher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
}

@Composable
private fun AppContent(
    state: MainUiState,
    resolveArtifactUrl: (String) -> String,
    onHubOriginChange: (String) -> Unit,
    onConnect: () -> Unit,
    onSelectAgent: (String) -> Unit,
    onBackToInbox: () -> Unit,
    onCreateSession: (String, String, String) -> Unit,
    onDeleteSession: (String) -> Unit,
    onQuickCommand: (String, String) -> Unit,
    onSendInstruction: (String, String) -> Unit,
    onSendSpecialKey: (String, String, List<String>) -> Unit,
    onSelectTuiMenuItem: (String, String?) -> Unit,
    onDismissTuiMenu: () -> Unit
) {
    val selectedAgent = state.agents.firstOrNull { it.agentId == state.selectedAgentId }
    BackHandler(enabled = selectedAgent != null) {
        onBackToInbox()
    }

    // TUI Menu Dialog
    val activeMenu = state.activeTuiMenu
    val context = LocalContext.current
    LaunchedEffect(activeMenu) {
        if (activeMenu != null) {
            android.util.Log.i("MainActivity", "Showing TUI menu dialog: ${activeMenu.title}")
            android.widget.Toast.makeText(context, "TUI Menu: ${activeMenu.title}", android.widget.Toast.LENGTH_SHORT).show()
        }
    }
    activeMenu?.let { menu ->
        TuiMenuDialog(
            menu = menu,
            onDismiss = onDismissTuiMenu,
            onSelect = onSelectTuiMenuItem
        )
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(appGradient)
    ) {
        if (selectedAgent == null) {
            InboxScreen(
                state = state,
                onHubOriginChange = onHubOriginChange,
                onConnect = onConnect,
                onSelectAgent = onSelectAgent,
                onCreateSession = onCreateSession,
                onDeleteSession = onDeleteSession
            )
        } else {
            ConversationScreen(
                state = state,
                agent = selectedAgent,
                events = state.events.filter { it.agentId == selectedAgent.agentId },
                resolveArtifactUrl = resolveArtifactUrl,
                onBackToInbox = onBackToInbox,
                onDeleteSession = onDeleteSession,
                onQuickCommand = onQuickCommand,
                onSendInstruction = onSendInstruction,
                onSendSpecialKey = onSendSpecialKey
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun InboxScreen(
    state: MainUiState,
    onHubOriginChange: (String) -> Unit,
    onConnect: () -> Unit,
    onSelectAgent: (String) -> Unit,
    onCreateSession: (String, String, String) -> Unit,
    onDeleteSession: (String) -> Unit
) {
    var showConnectionConfig by rememberSaveable { mutableStateOf(false) }
    var showCreateSessionDialog by rememberSaveable { mutableStateOf(false) }
    var deleteTarget by remember { mutableStateOf<ConversationCardState?>(null) }
    val conversationCards = remember(state.agents, state.events) {
        buildConversationCards(state.agents, state.events)
    }

    Scaffold(
        containerColor = Color.Transparent,
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                modifier = Modifier.statusBarsPadding(),
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = MaterialTheme.colorScheme.onBackground
                ),
                title = {
                    Text(
                        state.hostUsername.ifBlank { "unknown" },
                        fontWeight = FontWeight.SemiBold
                    )
                },
                actions = {
                    TextButton(onClick = { showCreateSessionDialog = true }) {
                        Text("New")
                    }
                    TextButton(onClick = { showConnectionConfig = !showConnectionConfig }) {
                        Text(if (showConnectionConfig) "Hide Hub" else "Hub")
                    }
                }
            )
        }
    ) { paddingValues ->
        deleteTarget?.let { target ->
            AlertDialog(
                onDismissRequest = { deleteTarget = null },
                title = { Text("Delete session") },
                text = {
                    Text("This will stop the tmux session and remove ${target.agent.displayName} from the inbox.")
                },
                confirmButton = {
                    Button(
                        onClick = {
                            onDeleteSession(target.agent.agentId)
                            deleteTarget = null
                        }
                    ) {
                        Text("Delete")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { deleteTarget = null }) {
                        Text("Cancel")
                    }
                }
            )
        }

        if (showCreateSessionDialog) {
            CreateSessionDialog(
                profiles = state.profiles,
                workspaceRootHint = state.workspaceRootHint,
                isCreating = state.isCreatingSession,
                onDismiss = { showCreateSessionDialog = false },
                onConfirm = { profileId, sessionName, workdir ->
                    onCreateSession(profileId, sessionName, workdir)
                    showCreateSessionDialog = false
                }
            )
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            item {
                InboxHeroCard(
                    agents = conversationCards.map { it.agent },
                    agentCount = conversationCards.size,
                    socketState = state.socketState,
                    connectionError = state.connectionError
                )
            }

            if (showConnectionConfig) {
                item {
                    ConnectionConfigCard(
                        hubOrigin = state.hubOrigin,
                        isConnecting = state.isConnecting,
                        socketState = state.socketState,
                        onHubOriginChange = onHubOriginChange,
                        onConnect = onConnect
                    )
                }
            }

            if (conversationCards.isEmpty()) {
                item {
                    EmptyInboxCard()
                }
            } else {
                items(conversationCards, key = { it.agent.agentId }) { conversation ->
                    AgentConversationCard(
                        conversation = conversation,
                        onClick = { onSelectAgent(conversation.agent.agentId) },
                        onDelete = { deleteTarget = conversation }
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConversationScreen(
    state: MainUiState,
    agent: AgentSnapshot,
    events: List<TimelineEvent>,
    resolveArtifactUrl: (String) -> String,
    onBackToInbox: () -> Unit,
    onDeleteSession: (String) -> Unit,
    onQuickCommand: (String, String) -> Unit,
    onSendInstruction: (String, String) -> Unit,
    onSendSpecialKey: (String, String, List<String>) -> Unit
) {
    var showDeleteConfirm by rememberSaveable(agent.agentId) { mutableStateOf(false) }
    val runtimeState = remember(events) { deriveConversationRuntimeState(events) }
    val tuiComposerState = remember(events) { deriveTuiComposerState(events) }

    Scaffold(
        containerColor = Color.Transparent,
        contentWindowInsets = WindowInsets(0),
        topBar = {
            TopAppBar(
                modifier = Modifier.statusBarsPadding(),
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = Color.Transparent,
                    titleContentColor = MaterialTheme.colorScheme.onBackground
                ),
                title = {
                    Column {
                        Text(agent.displayName, fontWeight = FontWeight.SemiBold)
                        ConversationMetaRow(
                            agent = agent,
                            socketState = state.socketState
                        )
                    }
                },
                navigationIcon = {
                    TextButton(onClick = onBackToInbox) {
                        Text("Back")
                    }
                },
                actions = {
                    TextButton(onClick = { showDeleteConfirm = true }) {
                        Text("Delete")
                    }
                }
            )
        },
        bottomBar = {
            Column {
                ConversationComposer(
                    agent = agent,
                    tuiComposerState = tuiComposerState,
                    onQuickCommand = onQuickCommand,
                    onSendInstruction = onSendInstruction,
                    onSendSpecialKey = onSendSpecialKey
                )
                ConversationRuntimeBar(runtimeState = runtimeState)
            }
        }
    ) { paddingValues ->
        if (showDeleteConfirm) {
            AlertDialog(
                onDismissRequest = { showDeleteConfirm = false },
                title = { Text("Delete session") },
                text = {
                    Text(
                        "This will stop the tmux session and remove this conversation from the inbox."
                    )
                },
                confirmButton = {
                    Button(
                        onClick = {
                            showDeleteConfirm = false
                            onDeleteSession(agent.agentId)
                        }
                    ) {
                        Text("Delete")
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showDeleteConfirm = false }) {
                        Text("Cancel")
                    }
                }
            )
        }

        val visibleEvents = remember(events) { timelineEventsForDisplay(events) }
        val listState = rememberLazyListState()

        LaunchedEffect(agent.agentId, visibleEvents.size) {
            if (visibleEvents.isNotEmpty()) {
                listState.scrollToItem(visibleEvents.lastIndex)
            }
        }

        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues),
            state = listState,
            contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            items(visibleEvents, key = { it.id }) { event ->
                TimelineMessageCard(
                    event = event,
                    agent = agent,
                    resolveArtifactUrl = resolveArtifactUrl
                )
            }
            if (visibleEvents.isEmpty()) {
                item {
                    EmptyTimelineCard()
                }
            }
        }
    }
}

@Composable
private fun ConversationRuntimeBar(runtimeState: ConversationRuntimeState) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
        tonalElevation = 0.dp
    ) {
        Text(
            text = formatContextUsage(runtimeState),
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 16.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.92f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun InboxHeroCard(
    agents: List<AgentSnapshot>,
    agentCount: Int,
    socketState: SocketConnectionState,
    connectionError: String?
) {
    val runningCount = agents.count { it.status.equals("busy", ignoreCase = true) || it.status.equals("running", ignoreCase = true) }
    val waitingCount = agents.count {
        it.status.equals("waiting_input", ignoreCase = true)
            || it.status.equals("need_approval", ignoreCase = true)
            || it.status.equals("need_user_input", ignoreCase = true)
    }
    val riskCount = agents.count { it.status.equals("failed", ignoreCase = true) || it.status.equals("offline", ignoreCase = true) }

    ElevatedCard(
        colors = CardDefaults.elevatedCardColors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)
        ),
        shape = RoundedCornerShape(28.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(
                        "$agentCount active conversations",
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        "Track agents, approvals and artifacts in one stream.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                SocketStateChip(socketState)
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                SummaryPill(label = "Running", value = runningCount.toString(), accent = Color(0xFFFFC76C))
                SummaryPill(label = "Waiting", value = waitingCount.toString(), accent = Color(0xFFFF9A76))
                SummaryPill(label = "Risk", value = riskCount.toString(), accent = Color(0xFFFF8D92))
            }
            connectionError?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}

@Composable
private fun ConnectionConfigCard(
    hubOrigin: String,
    isConnecting: Boolean,
    socketState: SocketConnectionState,
    onHubOriginChange: (String) -> Unit,
    onConnect: () -> Unit
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f)
        ),
        shape = RoundedCornerShape(24.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text("Hub Connection", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            OutlinedTextField(
                value = hubOrigin,
                onValueChange = onHubOriginChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Hub Origin") },
                singleLine = true,
                supportingText = {
                    Text("Supports local IP, Tailscale IP and Tailscale Serve HTTPS origin.")
                }
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    when (socketState) {
                        SocketConnectionState.CONNECTED -> "Realtime socket connected"
                        SocketConnectionState.CONNECTING -> "Connecting with fallback sync"
                        SocketConnectionState.DISCONNECTED -> "HTTP fallback sync active"
                    },
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
                Button(onClick = onConnect, enabled = !isConnecting) {
                    Text(if (isConnecting) "Connecting" else "Reconnect")
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CreateSessionDialog(
    profiles: List<AgentProfile>,
    workspaceRootHint: String,
    isCreating: Boolean,
    onDismiss: () -> Unit,
    onConfirm: (String, String, String) -> Unit
) {
    val orderedProfiles = remember(profiles) { sortAgentProfiles(profiles) }
    var sessionName by rememberSaveable { mutableStateOf("") }
    var workdir by rememberSaveable { mutableStateOf("") }
    var selectedProfileId by rememberSaveable(orderedProfiles) {
        mutableStateOf(preferredProfileId(orderedProfiles))
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("New tmux session") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(
                    "Choose an agent profile and a tmux session name.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                FlowRow(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    orderedProfiles.forEach { profile ->
                        AssistChip(
                            onClick = { selectedProfileId = profile.id },
                            label = { Text(profile.label) },
                            colors = AssistChipDefaults.assistChipColors(
                                containerColor = if (selectedProfileId == profile.id) {
                                    MaterialTheme.colorScheme.primaryContainer
                                } else {
                                    MaterialTheme.colorScheme.surfaceVariant
                                },
                                labelColor = if (selectedProfileId == profile.id) {
                                    MaterialTheme.colorScheme.onPrimaryContainer
                                } else {
                                    MaterialTheme.colorScheme.onSurfaceVariant
                                }
                            )
                        )
                    }
                }
                OutlinedTextField(
                    value = sessionName,
                    onValueChange = { sessionName = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Session name") },
                    placeholder = { Text("for example: opencode-fix-login") },
                    singleLine = true
                )
                OutlinedTextField(
                    value = workdir,
                    onValueChange = { workdir = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Workdir") },
                    placeholder = { Text("for example: tests/first_test") },
                    singleLine = true,
                    supportingText = {
                        Text("Will be created under $workspaceRootHint/")
                    }
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(selectedProfileId, sessionName.trim(), workdir.trim()) },
                enabled = !isCreating
                    && selectedProfileId.isNotBlank()
                    && sessionName.isNotBlank()
                    && workdir.isNotBlank()
            ) {
                Text(if (isCreating) "Creating" else "Create")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !isCreating) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun EmptyInboxCard() {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f)
        ),
        shape = RoundedCornerShape(26.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(22.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            Text("No agents online", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
            Text(
                "Start a tmux bridge or command bridge, then reconnect this inbox.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun AgentConversationCard(
    conversation: ConversationCardState,
    onClick: () -> Unit,
    onDelete: () -> Unit
) {
    val agent = conversation.agent
    val context = LocalContext.current
    val clipboardManager = LocalClipboardManager.current
    var showActions by remember { mutableStateOf(false) }
    if (showActions) {
        AlertDialog(
            onDismissRequest = { showActions = false },
            title = { Text(agent.displayName) },
            text = { Text("Choose an action for this conversation.") },
            confirmButton = {
                Button(
                    onClick = {
                        showActions = false
                        onDelete()
                    }
                ) {
                    Text("Delete")
                }
            },
            dismissButton = {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(
                        onClick = {
                            showActions = false
                            copyText(
                                clipboardManager = clipboardManager,
                                context = context,
                                label = "Conversation preview",
                                value = conversation.preview ?: agent.displayName
                            )
                        }
                    ) {
                        Text("Copy")
                    }
                    TextButton(onClick = { showActions = false }) {
                        Text("Cancel")
                    }
                }
            }
        )
    }

    Box {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .combinedClickable(
                    onClick = onClick,
                    onLongClick = {
                        showActions = true
                    }
                ),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.94f)
            ),
            shape = RoundedCornerShape(24.dp),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.35f))
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(inboxCardGradient)
                    .padding(16.dp),
                horizontalArrangement = Arrangement.spacedBy(14.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                AgentAvatar(agent = agent)
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(6.dp)
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(
                                agent.displayName,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold
                            )
                            prettyAgentLabel(agent).takeIf { it.isNotBlank() }?.let {
                                Text(
                                    it,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis
                                )
                            }
                        }
                        Text(
                            formatTimestamp(conversation.lastMessageAt),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        StatusBadge(agent.status)
                        Text(
                            tmuxSessionLine(agent),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Text(
                        conversation.preview ?: "Waiting for the next message.",
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
        Surface(
            modifier = Modifier
                .align(Alignment.TopStart)
                .padding(start = 14.dp)
                .offset(y = (-8).dp),
            color = MaterialTheme.colorScheme.secondaryContainer,
            shape = RoundedCornerShape(999.dp)
        ) {
            Text(
                text = eventTone(agent.status),
                modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSecondaryContainer
            )
        }
    }
}

@Composable
private fun ConversationMetaRow(agent: AgentSnapshot, socketState: SocketConnectionState) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = prettyAgentLabel(agent),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = agent.status.replace('_', ' '),
                style = MaterialTheme.typography.bodySmall,
                color = statusColors(agent.status).second,
                maxLines = 1
            )
            SocketStateDot(socketState = socketState)
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TimelineMessageCard(
    event: TimelineEvent,
    agent: AgentSnapshot,
    resolveArtifactUrl: (String) -> String
) {
    val bubbleColors = messageBubbleColors(event)
    val speaker = timelineSpeaker(event, agent)
    val alignment = when (event.eventType) {
        "user_command" -> Arrangement.End
        else -> Arrangement.Start
    }
    var selectableText by remember(event.id) { mutableStateOf<String?>(null) }

    selectableText?.let { text ->
        SelectableTextDialog(
            title = speaker ?: "Message",
            initialText = text,
            onDismiss = { selectableText = null }
        )
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = alignment
    ) {
        Card(
            modifier = Modifier
                .fillMaxWidth(0.9f)
                .combinedClickable(
                    onClick = {},
                    onLongClick = {
                        selectableText = timelineSelectableText(event)
                    }
                ),
            colors = CardDefaults.cardColors(containerColor = bubbleColors.first),
            shape = RoundedCornerShape(
                topStart = 22.dp,
                topEnd = 22.dp,
                bottomStart = if (event.eventType == "user_command") 22.dp else 8.dp,
                bottomEnd = if (event.eventType == "user_command") 8.dp else 22.dp
            )
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(14.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (speaker != null) {
                        Text(
                            speaker,
                            style = MaterialTheme.typography.labelMedium,
                            color = bubbleColors.second.copy(alpha = 0.76f),
                            fontWeight = FontWeight.SemiBold
                        )
                    } else {
                        Spacer(modifier = Modifier)
                    }
                    Text(
                        formatTimestamp(event.timestamp),
                        style = MaterialTheme.typography.bodySmall,
                        color = bubbleColors.second.copy(alpha = 0.7f)
                    )
                }

                timelineBody(event)?.let {
                    SelectableTimelineText(
                        text = it,
                        color = bubbleColors.second
                    )
                }

                event.artifact?.let { artifact ->
                    if (artifact.kind == "image") {
                        AsyncImage(
                            model = resolveArtifactUrl(artifact.url),
                            contentDescription = artifact.caption,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(18.dp))
                                .border(
                                    width = 1.dp,
                                    color = MaterialTheme.colorScheme.outline.copy(alpha = 0.25f),
                                    shape = RoundedCornerShape(18.dp)
                                ),
                            contentScale = ContentScale.FillWidth
                        )
                    }
                    artifact.caption?.let {
                        SelectableTimelineText(
                            text = it,
                            color = bubbleColors.second.copy(alpha = 0.8f),
                            styleBodySmall = true
                        )
                    }
                    if (artifact.kind != "image") {
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.8f),
                            shape = RoundedCornerShape(16.dp)
                        ) {
                            Text(
                                "Artifact · ${artifact.fileName}",
                                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SelectableTimelineText(
    text: String,
    color: Color,
    styleBodySmall: Boolean = false
) {
    SelectionContainer {
        Text(
            text = text,
            color = color,
            style = if (styleBodySmall) {
                MaterialTheme.typography.bodySmall
            } else {
                MaterialTheme.typography.bodyMedium
            }
        )
    }
}

@Composable
private fun SelectableTextDialog(
    title: String,
    initialText: String,
    onDismiss: () -> Unit
) {
    var fieldValue by rememberSaveable(stateSaver = TextFieldValue.Saver) {
        mutableStateOf(
            TextFieldValue(
                text = initialText,
                selection = TextRange(0, initialText.length)
            )
        )
    }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            OutlinedTextField(
                value = fieldValue,
                onValueChange = { fieldValue = it },
                modifier = Modifier.fillMaxWidth(),
                readOnly = true,
                minLines = 6,
                maxLines = 12
            )
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Done")
            }
        }
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConversationComposer(
    agent: AgentSnapshot,
    tuiComposerState: TuiComposerState?,
    onQuickCommand: (String, String) -> Unit,
    onSendInstruction: (String, String) -> Unit,
    onSendSpecialKey: (String, String, List<String>) -> Unit
) {
    var text by remember { mutableStateOf("") }
    var pendingModifiers by rememberSaveable(agent.agentId) { mutableStateOf(listOf<String>()) }
    var showLiteralKeyDialog by rememberSaveable(agent.agentId) { mutableStateOf(false) }
    var showSlashMenu by remember { mutableStateOf(false) }
    var slashMenuFilter by remember { mutableStateOf("") }

    LaunchedEffect(tuiComposerState != null) {
        if (tuiComposerState == null && pendingModifiers.isNotEmpty()) {
            pendingModifiers = emptyList()
        }
    }

    fun sendTuiKey(key: String) {
        onSendSpecialKey(agent.agentId, key, pendingModifiers)
        pendingModifiers = emptyList()
    }

    fun executeSlashCommand(node: SlashCommandNode, userInput: String?) {
        val commandType = node.commandType ?: return
        when {
            commandType == "send_text" && userInput != null -> {
                onSendInstruction(agent.agentId, userInput)
            }
            commandType == "send_text" -> {
                val commandText = "/${node.id}"
                onSendInstruction(agent.agentId, commandText)
            }
            else -> {
                onQuickCommand(agent.agentId, commandType)
            }
        }
    }

    if (showSlashMenu) {
        SlashCommandMenu(
            commands = agent.slashCommands,
            filter = slashMenuFilter,
            onDismiss = {
                showSlashMenu = false
                slashMenuFilter = ""
            },
            onExecute = { node, userInput ->
                executeSlashCommand(node, userInput)
                showSlashMenu = false
                slashMenuFilter = ""
                text = ""
            }
        )
    }

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .navigationBarsPadding(),
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.96f),
        tonalElevation = 6.dp,
        shadowElevation = 12.dp,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (tuiComposerState != null) {
                TuiKeypad(
                    prompt = tuiComposerState.prompt,
                    keyHints = tuiComposerState.keyHints,
                    pendingModifiers = pendingModifiers,
                    onModifierToggle = { modifier ->
                        pendingModifiers = if (pendingModifiers.contains(modifier)) {
                            pendingModifiers - modifier
                        } else {
                            pendingModifiers + modifier
                        }
                    },
                    onSendKey = ::sendTuiKey,
                    onLiteralKeyRequest = { showLiteralKeyDialog = true },
                    onClearPending = { pendingModifiers = emptyList() }
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { newText ->
                        text = newText
                        if (newText.startsWith("/") && !showSlashMenu) {
                            slashMenuFilter = newText.drop(1).trim()
                            showSlashMenu = true
                        } else if (showSlashMenu) {
                            slashMenuFilter = if (newText.startsWith("/")) {
                                newText.drop(1).trim()
                            } else {
                                showSlashMenu = false
                                ""
                            }
                        }
                    },
                    modifier = Modifier.weight(1f),
                    label = { Text("Message") },
                    placeholder = { Text(placeholderText(agent)) },
                    supportingText = {
                        val supported = agent.slashCommands.take(3).map { "/${it.label.lowercase()}" }
                        Text(
                            if (supported.isEmpty()) {
                                "Send plain text instructions."
                            } else {
                                "Type / for commands (${supported.joinToString(" ")})"
                            }
                        )
                    },
                    maxLines = 4
                )
                Button(
                    onClick = {
                        if (text.isNotBlank()) {
                            val input = text.trim()
                            val matched = matchSlashCommand(agent.slashCommands, input)
                            if (matched != null) {
                                executeSlashCommand(matched.first, matched.second)
                            } else {
                                onSendInstruction(agent.agentId, input)
                            }
                            text = ""
                        }
                    },
                    colors = ButtonDefaults.buttonColors(
                        containerColor = MaterialTheme.colorScheme.primary,
                        contentColor = MaterialTheme.colorScheme.onPrimary
                    )
                ) {
                    Text("Send")
                }
            }
        }
    }

    if (showLiteralKeyDialog) {
        LiteralKeyDialog(
            pendingModifiers = pendingModifiers,
            onDismiss = { showLiteralKeyDialog = false },
            onConfirm = { key ->
                sendTuiKey(key)
                showLiteralKeyDialog = false
            }
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TuiKeypad(
    prompt: String,
    keyHints: List<String>,
    pendingModifiers: List<String>,
    onModifierToggle: (String) -> Unit,
    onSendKey: (String) -> Unit,
    onLiteralKeyRequest: () -> Unit,
    onClearPending: () -> Unit
) {
    val suggestedKeys = remember(keyHints) { normalizeKeyHints(keyHints) }

    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.92f)
        ),
        shape = RoundedCornerShape(20.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Text(
                "TUI input mode",
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                prompt,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (pendingModifiers.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        "Pending: ${pendingModifiers.joinToString("+") { it.uppercase() }} + next key",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.primary
                    )
                    TextButton(onClick = onClearPending) {
                        Text("Clear")
                    }
                }
            }
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                ModifierChip(
                    label = "Ctrl",
                    active = pendingModifiers.contains("ctrl"),
                    onClick = { onModifierToggle("ctrl") }
                )
                TuiKeyChip(label = "↑", onClick = { onSendKey("up") })
                TuiKeyChip(label = "↓", onClick = { onSendKey("down") })
                TuiKeyChip(label = "←", onClick = { onSendKey("left") })
                TuiKeyChip(label = "→", onClick = { onSendKey("right") })
                TuiKeyChip(label = "Enter", onClick = { onSendKey("enter") })
                TuiKeyChip(label = "Esc", onClick = { onSendKey("esc") })
                TuiKeyChip(label = "Tab", onClick = { onSendKey("tab") })
                TuiKeyChip(label = "Bksp", onClick = { onSendKey("backspace") })
                TuiKeyChip(label = "Key", onClick = onLiteralKeyRequest)
                suggestedKeys.forEach { key ->
                    TuiKeyChip(label = key.uppercase(), onClick = { onSendKey(key) })
                }
            }
        }
    }
}

@Composable
private fun TuiKeyChip(label: String, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = { Text(label) }
    )
}

@Composable
private fun ModifierChip(label: String, active: Boolean, onClick: () -> Unit) {
    AssistChip(
        onClick = onClick,
        label = { Text(label) },
        colors = AssistChipDefaults.assistChipColors(
            containerColor = if (active) {
                MaterialTheme.colorScheme.primaryContainer
            } else {
                MaterialTheme.colorScheme.surface
            },
            labelColor = if (active) {
                MaterialTheme.colorScheme.onPrimaryContainer
            } else {
                MaterialTheme.colorScheme.onSurface
            }
        )
    )
}

@Composable
private fun LiteralKeyDialog(
    pendingModifiers: List<String>,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit
) {
    var value by rememberSaveable { mutableStateOf("") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Send single key") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (pendingModifiers.isNotEmpty()) {
                    Text(
                        "Will send ${pendingModifiers.joinToString("+") { it.uppercase() }} + key",
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                OutlinedTextField(
                    value = value,
                    onValueChange = { value = it.take(1) },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text("Key") },
                    placeholder = { Text("for example: c") },
                    singleLine = true
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onConfirm(value.trim()) },
                enabled = value.trim().length == 1
            ) {
                Text("Send")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun AgentAvatar(agent: AgentSnapshot) {
    val accent = when (agent.status.lowercase()) {
        "busy", "running" -> Color(0xFFFFB84D)
        "waiting_input", "need_approval", "need_user_input" -> Color(0xFFFF857E)
        "completed" -> Color(0xFF8BD3C7)
        "failed", "offline" -> Color(0xFFE57373)
        else -> Color(0xFF9DB8FF)
    }
    Box(
        modifier = Modifier
            .size(50.dp)
            .clip(CircleShape),
        contentAlignment = Alignment.Center
    ) {
        Box(
            modifier = Modifier
                .matchParentSize()
                .background(accent.copy(alpha = 0.18f))
        )
        Text(
            text = agent.displayName.take(2).uppercase(),
            color = accent,
            fontWeight = FontWeight.Bold
        )
        Box(
            modifier = Modifier
                .align(Alignment.BottomEnd)
                .size(12.dp)
                .clip(CircleShape)
                .background(accent)
                .border(2.dp, MaterialTheme.colorScheme.surface, CircleShape)
        )
    }
}

@Composable
private fun StatusBadge(status: String) {
    val (container, content) = statusColors(status)
    Surface(
        color = container,
        shape = RoundedCornerShape(999.dp)
    ) {
        Text(
            text = status.replace('_', ' '),
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            style = MaterialTheme.typography.labelMedium,
            color = content
        )
    }
}

@Composable
private fun SocketStateChip(socketState: SocketConnectionState) {
    val (container, content, label) = when (socketState) {
        SocketConnectionState.DISCONNECTED -> Triple(Color(0xFF4F2C2A), Color(0xFFFFC6C3), "Fallback")
        SocketConnectionState.CONNECTING -> Triple(Color(0xFF51411A), Color(0xFFFFE2A8), "Syncing")
        SocketConnectionState.CONNECTED -> Triple(Color(0xFF183A35), Color(0xFFA7F1E4), "Live")
    }
    Surface(color = container, shape = RoundedCornerShape(999.dp)) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelMedium,
            color = content
        )
    }
}

@Composable
private fun SocketStateDot(socketState: SocketConnectionState) {
    val color = when (socketState) {
        SocketConnectionState.DISCONNECTED -> Color(0xFFFF8D92)
        SocketConnectionState.CONNECTING -> Color(0xFFFFC76C)
        SocketConnectionState.CONNECTED -> Color(0xFF8BD3C7)
    }
    Box(
        modifier = Modifier
            .size(10.dp)
            .clip(CircleShape)
            .background(color)
            .border(1.5.dp, MaterialTheme.colorScheme.surface, CircleShape)
    )
}

@Composable
private fun SummaryPill(label: String, value: String, accent: Color) {
    Surface(
        color = accent.copy(alpha = 0.12f),
        shape = RoundedCornerShape(18.dp)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(accent)
            )
            Text(
                value,
                color = MaterialTheme.colorScheme.onSurface,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                label,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodySmall
            )
        }
    }
}

@Composable
private fun EmptyTimelineCard() {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.84f)
        ),
        shape = RoundedCornerShape(22.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            Text(
                "No messages yet",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                "Send a message or use a slash command to start this session.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

private fun placeholderText(agent: AgentSnapshot): String {
    return if (agent.slashCommands.isEmpty()) {
        "Ask the agent to continue, summarize, or fix something"
    } else {
        "Send text or type / for commands"
    }
}

private fun matchSlashCommand(
    commands: List<SlashCommandNode>,
    input: String
): Pair<SlashCommandNode, String?>? {
    if (!input.startsWith("/")) return null
    val afterSlash = input.drop(1).trim()
    if (afterSlash.isBlank()) return null

    val parts = afterSplit(afterSlash)
    val firstToken = parts.first.lowercase()

    val matched = findCommandByPath(commands, firstToken)
    if (matched == null) return null

    val userInput = parts.second.takeIf { it.isNotBlank() }
    return Pair(matched, userInput)
}

private fun afterSplit(text: String): Pair<String, String> {
    val idx = text.indexOf(' ')
    return if (idx > 0) {
        text.substring(0, idx) to text.substring(idx + 1)
    } else {
        text to ""
    }
}

private fun findCommandByPath(
    commands: List<SlashCommandNode>,
    token: String
): SlashCommandNode? {
    for (cmd in commands) {
        if (cmd.id.lowercase() == token || cmd.label.lowercase() == token) {
            if (cmd.requiresInput == true || cmd.children.isEmpty()) {
                return cmd
            }
            if (cmd.children.size == 1 && cmd.children[0].children.isEmpty()) {
                return cmd.children[0]
            }
            return cmd
        }
        val child = findCommandByPath(cmd.children, token)
        if (child != null) return child
    }
    return null
}

private fun flattenCommands(commands: List<SlashCommandNode>, prefix: String = ""): List<Pair<String, SlashCommandNode>> {
    val result = mutableListOf<Pair<String, SlashCommandNode>>()
    for (cmd in commands) {
        val path = if (prefix.isEmpty()) cmd.label else "$prefix / ${cmd.label}"
        if (cmd.children.isEmpty() || cmd.requiresInput == true) {
            result.add(path to cmd)
        }
        result.addAll(flattenCommands(cmd.children, path))
    }
    return result
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun SlashCommandMenu(
    commands: List<SlashCommandNode>,
    filter: String,
    onDismiss: () -> Unit,
    onExecute: (SlashCommandNode, String?) -> Unit
) {
    var selectedPath by remember { mutableStateOf<List<String>>(emptyList()) }
    var inputText by remember { mutableStateOf("") }

    val currentCommands = remember(selectedPath, commands) {
        var nodes = commands
        for (segment in selectedPath) {
            val found = nodes.find { it.id == segment || it.label == segment }
            if (found != null) {
                nodes = found.children
            } else {
                break
            }
        }
        nodes
    }

    val filtered = remember(currentCommands, filter) {
        if (filter.isEmpty()) {
            flattenCommands(currentCommands)
        } else {
            flattenCommands(currentCommands).filter { (_, cmd) ->
                cmd.label.contains(filter, ignoreCase = true)
                        || cmd.description?.contains(filter, ignoreCase = true) == true
                        || cmd.id.contains(filter, ignoreCase = true)
            }
        }
    }

    val currentNode = if (selectedPath.isNotEmpty()) {
        var node: SlashCommandNode? = null
        var nodes = commands
        for (segment in selectedPath) {
            node = nodes.find { it.id == segment || it.label == segment }
            if (node != null) nodes = node.children else break
        }
        node
    } else null

    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Column {
                Text("Slash Commands")
                if (selectedPath.isNotEmpty()) {
                    Text(
                        selectedPath.joinToString(" / "),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        },
        text = {
            Column(
                verticalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.heightIn(max = 400.dp)
            ) {
                if (currentNode?.requiresInput == true) {
                    OutlinedTextField(
                        value = inputText,
                        onValueChange = { inputText = it },
                        placeholder = { Text(currentNode.inputPlaceholder ?: "Enter value...") },
                        maxLines = 3
                    )
                    Button(
                        onClick = { onExecute(currentNode, inputText.takeIf { it.isNotBlank() }) },
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Text("Execute")
                    }
                }

                val scrollState = rememberScrollState()
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .verticalScroll(scrollState)
                        .weight(1f, fill = false),
                    verticalArrangement = Arrangement.spacedBy(4.dp)
                ) {
                    if (filtered.isNotEmpty()) {
                        filtered.forEach { (path, cmd) ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable {
                                        if (cmd.requiresInput == true) {
                                            onExecute(cmd, null)
                                        } else if (cmd.children.isNotEmpty()) {
                                            selectedPath = selectedPath + cmd.id
                                        } else {
                                            onExecute(cmd, null)
                                        }
                                    }
                                    .padding(vertical = 8.dp),
                                horizontalArrangement = Arrangement.SpaceBetween,
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                Column(modifier = Modifier.weight(1f)) {
                                    Text(cmd.label, fontWeight = FontWeight.Medium)
                                    if (cmd.description != null) {
                                        Text(
                                            cmd.description,
                                            style = MaterialTheme.typography.bodySmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant
                                        )
                                    }
                                }
                                if (cmd.children.isNotEmpty()) {
                                    Text("→", color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    } else if (currentNode?.requiresInput != true) {
                        Text(
                            "No matching commands",
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

private fun quickCommandLabels(agent: AgentSnapshot): List<String> {
    val preferred = if (agent.quickCommands.isEmpty()) {
        listOf("status", "approve", "retry", "stop")
    } else {
        agent.quickCommands
    }
    return preferred.distinct().take(5)
}

private fun slashCommandLabels(agent: AgentSnapshot): List<String> {
    return quickCommandLabels(agent).map { "/$it" }
}

private fun slashCommandPlaceholder(agent: AgentSnapshot): String {
    val commands = slashCommandLabels(agent)
    return if (commands.isEmpty()) {
        "Ask the agent to continue, summarize, or fix something"
    } else {
        "Send text or ${commands.joinToString(" ")}"
    }
}

private fun parseSlashCommand(agent: AgentSnapshot, input: String): String? {
    if (!input.startsWith("/")) {
        return null
    }
    val command = input.drop(1).trim().lowercase()
    if (command.isBlank()) {
        return null
    }
    return quickCommandLabels(agent).firstOrNull { it.lowercase() == command }
}

private fun eventTone(status: String): String {
    return when (status.lowercase()) {
        "busy", "running" -> "active"
        "waiting_input", "need_approval", "need_user_input" -> "waiting"
        "completed" -> "done"
        "failed", "offline" -> "risk"
        else -> "ready"
    }
}

private fun timelineTitle(event: TimelineEvent): String {
    return event.title ?: when (event.eventType) {
        "user_command" -> "You"
        "task_running" -> "Running"
        "task_completed" -> "Completed"
        "task_failed" -> "Failed"
        "need_approval" -> "Approval needed"
        "need_user_input" -> "Input needed"
        "artifact_generated" -> "Artifact"
        "image_available" -> "Preview"
        "agent_started" -> "Agent started"
        "agent_stopped" -> "Agent stopped"
        else -> event.eventType.replace('_', ' ')
    }
}

private fun timelineSpeaker(event: TimelineEvent, agent: AgentSnapshot): String? {
    return when (event.eventType) {
        "user_command" -> null
        else -> eventModelLabel(event) ?: prettyAgentLabel(agent)
    }
}

private fun timelineBody(event: TimelineEvent): String? {
        return event.body?.takeIf { it.isNotBlank() }
            ?: event.artifact?.caption?.takeIf { it.isNotBlank() }
            ?: when (event.eventType) {
            "task_completed" -> "Completed."
            "task_failed" -> "Failed."
            "need_approval" -> "Waiting for approval."
            "agent_started" -> "Online."
            "agent_stopped" -> "Offline."
            else -> null
        }
}

private fun timelineEventsForDisplay(events: List<TimelineEvent>): List<TimelineEvent> {
    return events.filterNot { event ->
        (event.eventType == "user_command" && event.body.isNullOrBlank())
            || event.eventType == "task_running"
            || event.eventType == "task_completed"
            || event.eventType == "agent_started"
            || event.eventType == "agent_stopped"
            || (timelineBody(event) == null && event.artifact == null)
    }
}

private fun buildConversationCards(
    agents: List<AgentSnapshot>,
    events: List<TimelineEvent>
): List<ConversationCardState> {
    val conversationByAgent = agents.associateBy { it.agentId }
    val latestByAgent = mutableMapOf<String, TimelineEvent>()

    for (event in events) {
        if (!isConversationEvent(event)) {
            continue
        }

        val current = latestByAgent[event.agentId]
        if (current == null || event.timestamp > current.timestamp) {
            latestByAgent[event.agentId] = event
        }
    }

    return agents.map { agent ->
        val latest = latestByAgent[agent.agentId]
        ConversationCardState(
            agent = conversationByAgent[agent.agentId] ?: agent,
            lastMessageAt = latest?.timestamp ?: agent.lastSeenAt,
            preview = latest?.let(::conversationPreview)
        )
    }.sortedByDescending { it.lastMessageAt }
}

private fun isConversationEvent(event: TimelineEvent): Boolean {
    if (event.eventType == "task_running" || event.eventType == "task_completed" || event.eventType == "agent_started" || event.eventType == "agent_stopped") {
        return false
    }

    if (event.eventType == "user_command" && event.body.isNullOrBlank()) {
        return false
    }

    return conversationPreview(event) != null || event.artifact != null
}

private fun conversationPreview(event: TimelineEvent): String? {
    val body = event.body?.trim()
    if (!body.isNullOrEmpty()) {
        return body
    }

    val caption = event.artifact?.caption?.trim()
    if (!caption.isNullOrEmpty()) {
        return caption
    }

    return when (event.eventType) {
        "need_approval" -> "Waiting for approval."
        "image_available" -> "Image preview available."
        "artifact_generated" -> "Artifact available."
        else -> null
    }
}

private fun timelineSelectableText(event: TimelineEvent): String? {
    val body = event.body?.trim()
    if (!body.isNullOrEmpty()) {
        return body
    }

    val caption = event.artifact?.caption?.trim()
    if (!caption.isNullOrEmpty()) {
        return caption
    }

    return event.artifact?.fileName?.trim()?.takeIf { it.isNotEmpty() }
}

@Composable
private fun messageBubbleColors(event: TimelineEvent): Pair<Color, Color> {
    return when (event.eventType) {
        "user_command" -> Pair(MaterialTheme.colorScheme.primaryContainer, MaterialTheme.colorScheme.onPrimaryContainer)
        "task_failed" -> Pair(Color(0xFF4A1E23), Color(0xFFFFD9DD))
        "task_completed" -> Pair(Color(0xFF173A33), Color(0xFFB8F4E9))
        "need_approval", "need_user_input" -> Pair(Color(0xFF52401E), Color(0xFFFFE8B8))
        else -> Pair(MaterialTheme.colorScheme.surfaceVariant, MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun prettyAgentLabel(agent: AgentSnapshot): String {
    return when (agent.kind.lowercase()) {
        "opencode", "open-code", "open_code" -> "opencode"
        "codex", "codex-bridge" -> "codex"
        "copilot", "github-copilot", "github_copilot" -> "copilot"
        "qwen", "qwen-cli", "qwen-coder" -> "qwen"
        "tmux", "tmux-agent" -> "tmux"
        else -> agent.kind.lowercase()
    }
}

private fun sortAgentProfiles(profiles: List<AgentProfile>): List<AgentProfile> {
    val preferredOrder = listOf("opencode", "qwen", "codex", "copilot")
    return profiles.sortedWith(
        compareBy<AgentProfile> { profile ->
            preferredOrder.indexOf(profile.id).let { if (it == -1) Int.MAX_VALUE else it }
        }.thenBy { it.label.lowercase() }
    )
}

private fun preferredProfileId(profiles: List<AgentProfile>): String {
    return profiles.firstOrNull { it.id == "opencode" }?.id
        ?: profiles.firstOrNull()?.id
        ?: ""
}

private fun deriveConversationRuntimeState(events: List<TimelineEvent>): ConversationRuntimeState {
    val latestMetadata = events
        .asSequence()
        .filter { it.metadata != null }
        .filter { it.eventType == "text_output" || it.eventType == "task_running" || it.eventType == "task_completed" || it.eventType == "task_failed" }
        .maxByOrNull { it.timestamp }
        ?.metadata
        ?: return ConversationRuntimeState()

    return ConversationRuntimeState(
        contextUsedTokens = latestMetadata.intValue("contextUsedTokens")
            ?: latestMetadata.intValue("totalTokens")
            ?: latestMetadata.intValue("inputTokens"),
        contextWindowTokens = latestMetadata.intValue("contextWindowTokens")
    )
}

private fun deriveTuiComposerState(events: List<TimelineEvent>): TuiComposerState? {
    val latestNeedInput = events
        .asSequence()
        .filter { it.eventType == "need_user_input" }
        .maxByOrNull { it.timestamp }
        ?: return null

    if (latestNeedInput.metadata?.stringValue("inputMode") != "tui" || latestNeedInput.body.isNullOrBlank()) {
        return null
    }

    return TuiComposerState(
        prompt = latestNeedInput.body.orEmpty(),
        keyHints = latestNeedInput.metadata?.stringListValue("keyHints").orEmpty()
    )
}

private fun eventModelLabel(event: TimelineEvent): String? {
    return event.metadata?.get("model")?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
}

private fun formatCompactTokens(value: Int): String {
    val absolute = kotlin.math.abs(value.toDouble())
    return when {
        absolute >= 1_000_000 -> String.format("%.1fM", value / 1_000_000.0)
        absolute >= 1_000 -> String.format("%.1fk", value / 1_000.0)
        else -> value.toString()
    }
}

private fun formatContextUsage(runtimeState: ConversationRuntimeState): String {
    val used = runtimeState.contextUsedTokens?.let(::formatCompactTokens) ?: "NA"
    val window = runtimeState.contextWindowTokens?.let(::formatCompactTokens) ?: "NA"
    return "$used/$window"
}

private fun kotlinx.serialization.json.JsonObject.stringValue(key: String): String? {
    return this[key]?.jsonPrimitive?.contentOrNull?.takeIf { it.isNotBlank() }
}

private fun kotlinx.serialization.json.JsonObject.intValue(key: String): Int? {
    return this[key]?.jsonPrimitive?.contentOrNull?.toIntOrNull()
}

private fun kotlinx.serialization.json.JsonObject.stringListValue(key: String): List<String> {
    val raw = this[key] ?: return emptyList()
    return raw.jsonArray.mapNotNull { item ->
        item.jsonPrimitive.contentOrNull?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }
    }
}

private fun normalizeKeyHints(keyHints: List<String>): List<String> {
    val reserved = setOf("up", "down", "left", "right", "enter", "esc", "tab", "backspace")
    return keyHints
        .map { it.trim().lowercase() }
        .filter { it.length == 1 && it !in reserved }
        .distinct()
        .take(6)
}

private fun tmuxSessionLine(agent: AgentSnapshot): String {
    val sessionName = agent.sessionHint?.takeIf { it.isNotBlank() }
    return if (sessionName != null && sessionName != agent.displayName) {
        "${prettyAgentLabel(agent)} · $sessionName"
    } else {
        prettyAgentLabel(agent)
    }
}

private fun statusColors(status: String): Pair<Color, Color> {
    return when (status.lowercase()) {
        "busy", "running" -> Pair(Color(0xFF5A4313), Color(0xFFFFE0A8))
        "waiting_input", "need_approval", "need_user_input" -> Pair(Color(0xFF5A2D1F), Color(0xFFFFD7C8))
        "completed" -> Pair(Color(0xFF1F463E), Color(0xFFB7F4E8))
        "failed", "offline" -> Pair(Color(0xFF54252A), Color(0xFFFFCCD1))
        else -> Pair(Color(0xFF23344A), Color(0xFFCFE3FF))
    }
}

private fun formatTimestamp(raw: String): String {
    return runCatching {
        val instant = Instant.parse(raw)
        DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(instant)
    }.getOrElse { raw }
}

private fun copyText(
    clipboardManager: ClipboardManager,
    context: android.content.Context,
    label: String,
    value: String
) {
    clipboardManager.setText(AnnotatedString(value))
    Toast.makeText(context, "$label copied", Toast.LENGTH_SHORT).show()
}

private fun readDebugCommandProbe(intent: Intent?, isDebuggableBuild: Boolean): DebugCommandProbe? {
    if (!isDebuggableBuild || intent == null || !intent.getBooleanExtra(debugProbeEnabledKey, false)) {
        return null
    }

    val command = intent.getStringExtra(debugProbeCommandKey)?.trim().orEmpty()
    if (command.isEmpty()) {
        Log.w(debugProbeTag, "Ignoring debug probe because command is missing")
        return null
    }

    val probe = DebugCommandProbe(
        agentId = intent.getStringExtra(debugProbeAgentIdKey)?.trim()?.ifEmpty { null },
        command = command,
        text = intent.getStringExtra(debugProbeTextKey),
        delayMs = intent.getLongExtra(debugProbeDelayMsKey, 1200L).coerceAtLeast(0L)
    )

    Log.i(
        debugProbeTag,
        "Configured debug probe: agentId=${probe.agentId ?: "<auto>"} command=${probe.command}"
    )
    return probe
}

private fun readDebugHubOrigin(intent: Intent?, isDebuggableBuild: Boolean): String? {
    if (!isDebuggableBuild || intent == null) {
        return null
    }

    val origin = intent.getStringExtra(debugHubOriginKey)?.trim().orEmpty()
    if (origin.isEmpty()) {
        return null
    }

    Log.i(debugProbeTag, "Applying debug hub origin override: $origin")
    return origin
}

private fun readOpenAgentId(intent: Intent?): String? {
    val agentId = intent?.getStringExtra(openAgentIdKey)?.trim().orEmpty()
    return agentId.ifEmpty { null }
}

private fun ComponentActivity.isDebuggableBuild(): Boolean {
    return (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun TuiMenuDialog(
    menu: TuiMenu,
    onDismiss: () -> Unit,
    onSelect: (String, String?) -> Unit
) {
    var selectedInput by rememberSaveable { mutableStateOf("") }
    val scrollState = rememberScrollState()
    val optionItems = remember(menu.items) {
        menu.items.filterNot { it.id.startsWith("__") }
    }
    val cancelAction = remember(menu.items) {
        menu.items.firstOrNull { it.id == "__cancel__" }
    }
    val primaryAction = remember(menu.items) {
        menu.items.firstOrNull { it.id != "__cancel__" && it.id.startsWith("__") }
    }
    val inputAction = remember(menu.items) {
        menu.items.firstOrNull { it.isInput == true }
    }
    val bodyText = menu.body?.trim().orEmpty().ifEmpty { null }

    fun submitAction(action: TuiMenuItem) {
        val inputValue = if (action.isInput == true) {
            selectedInput.trim().takeIf { it.isNotEmpty() }
        } else {
            null
        }
        onSelect(action.id, inputValue)
    }

    AlertDialog(
        onDismissRequest = {
            if (cancelAction != null || optionItems.isNotEmpty()) {
                onSelect(cancelAction?.id ?: "__cancel__", null)
            } else {
                onDismiss()
            }
        },
        title = { Text(menu.title) },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(max = 400.dp)
                    .verticalScroll(scrollState),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                if (bodyText != null) {
                    SelectionContainer {
                        Text(
                            bodyText,
                            modifier = Modifier.fillMaxWidth(),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                }

                if (inputAction != null) {
                    OutlinedTextField(
                        value = selectedInput,
                        onValueChange = { selectedInput = it },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = if (bodyText != null) 8.dp else 0.dp),
                        placeholder = { Text(inputAction.inputPlaceholder ?: "Enter value...") },
                        singleLine = true
                    )
                }

                optionItems.forEach { item ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .combinedClickable(
                                onClick = {
                                    onSelect(item.id, null)
                                }
                            ),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                        shape = RoundedCornerShape(12.dp)
                    ) {
                        Column(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 10.dp)
                        ) {
                            Text(
                                item.label,
                                fontWeight = FontWeight.Medium
                            )
                            item.description?.let { desc ->
                                Text(
                                    desc,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            primaryAction?.let { action ->
                Button(
                    onClick = { submitAction(action) },
                    enabled = action.isInput != true || selectedInput.isNotBlank()
                ) {
                    Text(action.label)
                }
            }
        },
        dismissButton = {
            TextButton(
                onClick = {
                    if (cancelAction != null || optionItems.isNotEmpty()) {
                        onSelect(cancelAction?.id ?: "__cancel__", null)
                    } else {
                        onDismiss()
                    }
                }
            ) {
                Text(cancelAction?.label ?: "Cancel")
            }
        }
    )
}

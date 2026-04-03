package im.agent.personal

import android.content.Intent
import android.content.pm.ApplicationInfo
import android.os.Bundle
import android.util.Log
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
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
        readDebugHubOrigin(intent, isDebuggableBuild)?.let(viewModel::updateHubOrigin)

        setContent {
            AgentImTheme {
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
                    onSendInstruction = viewModel::sendInstruction
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
    onSendInstruction: (String, String) -> Unit
) {
    val selectedAgent = state.agents.firstOrNull { it.agentId == state.selectedAgentId }
    BackHandler(enabled = selectedAgent != null) {
        onBackToInbox()
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
                onCreateSession = onCreateSession
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
                onSendInstruction = onSendInstruction
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
    onCreateSession: (String, String, String) -> Unit
) {
    var showConnectionConfig by rememberSaveable { mutableStateOf(false) }
    var showCreateSessionDialog by rememberSaveable { mutableStateOf(false) }

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
                        Text("Agent Inbox", fontWeight = FontWeight.SemiBold)
                        Text(
                            "Personal private agent control",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
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
                    agents = state.agents,
                    agentCount = state.agents.size,
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

            if (state.agents.isEmpty()) {
                item {
                    EmptyInboxCard()
                }
            } else {
                items(state.agents, key = { it.agentId }) { agent ->
                    AgentConversationCard(
                        agent = agent,
                        onClick = { onSelectAgent(agent.agentId) }
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
    onSendInstruction: (String, String) -> Unit
) {
    var showDeleteConfirm by rememberSaveable(agent.agentId) { mutableStateOf(false) }

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
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            StatusBadge(agent.status)
                            Text(
                                agent.kind,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
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
            ConversationComposer(
                agent = agent,
                onQuickCommand = onQuickCommand,
                onSendInstruction = onSendInstruction
            )
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
            item {
                AgentHeaderCard(agent = agent, socketState = state.socketState)
            }
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
                        SocketConnectionState.CONNECTING -> "Connecting and polling"
                        SocketConnectionState.DISCONNECTED -> "Polling fallback active"
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
    var sessionName by rememberSaveable { mutableStateOf("") }
    var workdir by rememberSaveable { mutableStateOf("") }
    var selectedProfileId by rememberSaveable(profiles) {
        mutableStateOf(profiles.firstOrNull()?.id.orEmpty())
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
                    profiles.forEach { profile ->
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
                    placeholder = { Text("for example: codex-fix-login") },
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
                "Start a demo agent, tmux bridge or command bridge, then reconnect this inbox.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun AgentConversationCard(
    agent: AgentSnapshot,
    onClick: () -> Unit
) {
    Box {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(onClick = onClick),
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
                            formatTimestamp(agent.lastSeenAt),
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
                        agent.lastMessage ?: "Waiting for the next event.",
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (agent.capabilities.isNotEmpty()) {
                        Text(
                            agent.capabilities.take(3).joinToString("  ·  "),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
                        )
                    }
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun AgentHeaderCard(agent: AgentSnapshot, socketState: SocketConnectionState) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.92f)
        ),
        shape = RoundedCornerShape(24.dp)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    AgentAvatar(agent = agent)
                    Column {
                        Text(agent.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold)
                        Text(
                            tmuxSessionLine(agent),
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }
                }
                SocketStateChip(socketState)
            }

            if (agent.capabilities.isNotEmpty()) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    agent.capabilities.forEach { capability ->
                        CapabilityPill(label = capability)
                    }
                }
            }
        }
    }
}

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

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = alignment
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(0.9f),
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
                    Text(it, color = bubbleColors.second)
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
                        Text(
                            it,
                            style = MaterialTheme.typography.bodySmall,
                            color = bubbleColors.second.copy(alpha = 0.8f)
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

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ConversationComposer(
    agent: AgentSnapshot,
    onQuickCommand: (String, String) -> Unit,
    onSendInstruction: (String, String) -> Unit
) {
    var text by remember { mutableStateOf("") }

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
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                quickCommandLabels(agent).forEach { command ->
                    AssistChip(
                        onClick = { onQuickCommand(agent.agentId, command) },
                        label = { Text(commandLabel(command)) },
                        colors = AssistChipDefaults.assistChipColors(
                            containerColor = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.9f),
                            labelColor = MaterialTheme.colorScheme.onSurface
                        )
                    )
                }
            }
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.Bottom
            ) {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    modifier = Modifier.weight(1f),
                    label = { Text("Instruction") },
                    placeholder = { Text("Ask the agent to continue, approve, summarize...") },
                    maxLines = 4
                )
                Button(
                    onClick = {
                        if (text.isNotBlank()) {
                            onSendInstruction(agent.agentId, text.trim())
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
private fun CapabilityPill(label: String) {
    Surface(
        color = MaterialTheme.colorScheme.secondaryContainer.copy(alpha = 0.82f),
        shape = RoundedCornerShape(999.dp)
    ) {
        Text(
            label,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSecondaryContainer
        )
    }
}

@Composable
private fun SocketStateChip(socketState: SocketConnectionState) {
    val (container, content, label) = when (socketState) {
        SocketConnectionState.DISCONNECTED -> Triple(Color(0xFF4F2C2A), Color(0xFFFFC6C3), "Polling")
        SocketConnectionState.CONNECTING -> Triple(Color(0xFF51411A), Color(0xFFFFE2A8), "Connecting")
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
                "Use a quick command or send an instruction to start this session.",
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

private fun quickCommandLabels(agent: AgentSnapshot): List<String> {
    val preferred = if (agent.quickCommands.isEmpty()) {
        listOf("status", "approve", "retry", "stop")
    } else {
        agent.quickCommands
    }
    return preferred.distinct().take(5)
}

private fun commandLabel(command: String): String {
    return command.replaceFirstChar { it.uppercase() }.replace('_', ' ')
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
        else -> prettyAgentLabel(agent)
    }
}

private fun timelineBody(event: TimelineEvent): String? {
    return event.body?.takeIf { it.isNotBlank() }
        ?: event.artifact?.caption?.takeIf { it.isNotBlank() }
        ?: when (event.eventType) {
            "task_completed" -> "Completed."
            "task_failed" -> "Failed."
            "need_approval" -> "Waiting for approval."
            "need_user_input" -> "Waiting for input."
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
        "codex", "codex-bridge" -> "codex"
        "copilot", "github-copilot", "github_copilot" -> "copilot"
        "qwen", "qwen-cli", "qwen-coder" -> "qwen"
        "tmux", "tmux-agent" -> "tmux"
        else -> agent.kind.lowercase()
    }
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

private fun ComponentActivity.isDebuggableBuild(): Boolean {
    return (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
}

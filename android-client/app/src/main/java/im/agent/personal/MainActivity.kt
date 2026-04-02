package im.agent.personal

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<MainViewModel>()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                val uiState by viewModel.uiState.collectAsStateWithLifecycle()
                LaunchedEffect(Unit) { viewModel.load() }
                AppContent(
                    state = uiState,
                    resolveArtifactUrl = viewModel::resolveArtifactUrl,
                    onHubOriginChange = viewModel::updateHubOrigin,
                    onConnect = viewModel::connect,
                    onSelectAgent = viewModel::selectAgent,
                    onQuickCommand = viewModel::sendQuickCommand,
                    onSendInstruction = viewModel::sendInstruction
                )
            }
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
    onQuickCommand: (String, String) -> Unit,
    onSendInstruction: (String, String) -> Unit
) {
    Row(modifier = Modifier.fillMaxSize()) {
        LazyColumn(
            modifier = Modifier
                .weight(0.38f)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            items(state.agents) { agent ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onSelectAgent(agent.agentId) }
                ) {
                    Column(modifier = Modifier.padding(12.dp)) {
                        Text(agent.displayName, style = MaterialTheme.typography.titleMedium)
                        Text("${agent.kind} · ${agent.status}")
                        Text(agent.lastMessage ?: "No messages yet")
                    }
                }
            }
        }

        val selectedAgent = state.agents.firstOrNull { it.agentId == state.selectedAgentId }
        val events = state.events.filter { it.agentId == state.selectedAgentId }

        Column(
            modifier = Modifier
                .weight(0.62f)
                .padding(12.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OutlinedTextField(
                value = state.hubOrigin,
                onValueChange = onHubOriginChange,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("Hub Origin") },
                singleLine = true
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onConnect, enabled = !state.isConnecting) {
                    Text(if (state.isConnecting) "Connecting" else "Connect")
                }
                state.connectionError?.let { Text(it) }
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(selectedAgent?.displayName ?: "Select an agent", style = MaterialTheme.typography.headlineSmall)
            selectedAgent?.let { agent ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onQuickCommand(agent.agentId, "status") }) { Text("Status") }
                    Button(onClick = { onQuickCommand(agent.agentId, "approve") }) { Text("Approve") }
                    Button(onClick = { onQuickCommand(agent.agentId, "retry") }) { Text("Retry") }
                    Button(onClick = { onQuickCommand(agent.agentId, "stop") }) { Text("Stop") }
                }
                InstructionComposer(agent.agentId, onSendInstruction)
            }
            LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                items(events) { event ->
                    Card(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(12.dp)) {
                            Text(event.title ?: event.eventType, style = MaterialTheme.typography.titleMedium)
                            event.body?.let { Text(it) }
                            event.artifact?.let { artifact ->
                                if (artifact.kind == "image") {
                                    AsyncImage(
                                        model = resolveArtifactUrl(artifact.url),
                                        contentDescription = artifact.caption
                                    )
                                } else {
                                    Text("Artifact: ${artifact.fileName}")
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun InstructionComposer(
    agentId: String,
    onSendInstruction: (String, String) -> Unit
) {
    var text by remember { mutableStateOf("") }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.weight(1f),
            label = { Text("Instruction") }
        )
        Button(onClick = {
            onSendInstruction(agentId, text)
            text = ""
        }) {
            Text("Send")
        }
    }
}

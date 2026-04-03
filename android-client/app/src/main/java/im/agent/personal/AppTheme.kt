package im.agent.personal

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AgentImColors = darkColorScheme(
    primary = Color(0xFFFFB84D),
    onPrimary = Color(0xFF2A1800),
    primaryContainer = Color(0xFF5B3A00),
    onPrimaryContainer = Color(0xFFFFD9A0),
    secondary = Color(0xFF8BD3C7),
    onSecondary = Color(0xFF07231F),
    secondaryContainer = Color(0xFF133A35),
    onSecondaryContainer = Color(0xFFA7F1E4),
    tertiary = Color(0xFFB7C4FF),
    onTertiary = Color(0xFF14204D),
    background = Color(0xFF0E1116),
    onBackground = Color(0xFFF1F3F7),
    surface = Color(0xFF161B22),
    onSurface = Color(0xFFF1F3F7),
    surfaceVariant = Color(0xFF232A34),
    onSurfaceVariant = Color(0xFFBAC4D2),
    outline = Color(0xFF4D5A69),
    error = Color(0xFFFF857E),
    onError = Color(0xFF3A0A07)
)

@Composable
fun AgentImTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = AgentImColors,
        typography = MaterialTheme.typography,
        content = content
    )
}

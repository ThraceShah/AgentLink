package im.agent.link

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

private val AgentImColors = darkColorScheme(
    primary = Color(0xFFFFC768),
    onPrimary = Color(0xFF2A1800),
    primaryContainer = Color(0xFF714800),
    onPrimaryContainer = Color(0xFFFFE6B9),
    secondary = Color(0xFF98E5D7),
    onSecondary = Color(0xFF07231F),
    secondaryContainer = Color(0xFF1C4741),
    onSecondaryContainer = Color(0xFFBBFFF3),
    tertiary = Color(0xFFC7D2FF),
    onTertiary = Color(0xFF14204D),
    background = Color(0xFF11151C),
    onBackground = Color(0xFFF7F8FB),
    surface = Color(0xFF1B212B),
    onSurface = Color(0xFFF7F8FB),
    surfaceVariant = Color(0xFF2C3440),
    onSurfaceVariant = Color(0xFFD4DCE8),
    outline = Color(0xFF738195),
    error = Color(0xFFFF9C94),
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

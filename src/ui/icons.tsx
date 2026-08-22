/**
 * Inline SVG-free icons.
 *
 * react-native-svg is not a dependency yet, so these are drawn with plain Views.
 * Crude but honest: no emoji, no icon font, nothing to download, and they scale
 * with the colour tokens like everything else.
 */

import { View } from 'react-native';
import { C } from './theme';

export function Glyph({
  name,
  color = C.faint,
  size = 20,
}: {
  name: 'plus' | 'list' | 'pin' | 'wave' | 'wrench';
  color?: string;
  size?: number;
}) {
  const t = Math.max(2, Math.round(size / 10)); // stroke thickness

  if (name === 'plus') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ position: 'absolute', width: size, height: t, backgroundColor: color, borderRadius: t }} />
        <View style={{ position: 'absolute', width: t, height: size, backgroundColor: color, borderRadius: t }} />
      </View>
    );
  }

  if (name === 'list') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'space-evenly' }}>
        {[1, 0.85, 0.6].map((w, i) => (
          <View key={i} style={{ width: size * w, height: t, backgroundColor: color, borderRadius: t }} />
        ))}
      </View>
    );
  }

  if (name === 'pin') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: size * 0.7,
            height: size * 0.7,
            borderRadius: size * 0.35,
            borderWidth: t,
            borderColor: color,
          }}
        />
        <View
          style={{
            position: 'absolute',
            width: t,
            height: t,
            borderRadius: t,
            backgroundColor: color,
          }}
        />
      </View>
    );
  }

  if (name === 'wave') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            width: size * 0.28,
            height: size * 0.28,
            borderRadius: size * 0.14,
            backgroundColor: color,
          }}
        />
        <View
          style={{
            position: 'absolute',
            width: size * 0.68,
            height: size * 0.68,
            borderRadius: size * 0.34,
            borderWidth: t * 0.8,
            borderColor: color,
            opacity: 0.55,
          }}
        />
        <View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: size / 2,
            borderWidth: t * 0.8,
            borderColor: color,
            opacity: 0.25,
          }}
        />
      </View>
    );
  }

  // wrench — diagnostics
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size * 0.85,
          height: t,
          backgroundColor: color,
          borderRadius: t,
          transform: [{ rotate: '-45deg' }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          top: 0,
          right: size * 0.1,
          width: size * 0.42,
          height: size * 0.42,
          borderRadius: size * 0.21,
          borderWidth: t,
          borderColor: color,
        }}
      />
    </View>
  );
}

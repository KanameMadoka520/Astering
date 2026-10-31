<template>
	<svg
		class="compass-sky"
		viewBox="0 0 1200 360"
		preserveAspectRatio="xMaxYMid slice"
		aria-hidden="true"
		focusable="false"
	>
		<g
			class="compass-sky__astrolabe"
			fill="none"
			stroke="currentColor"
			stroke-width="1"
		>
			<circle
				v-for="ring in RINGS"
				:key="ring.r"
				:cx="CENTER.x"
				:cy="CENTER.y"
				:r="ring.r"
				:stroke-opacity="ring.opacity"
				:stroke-dasharray="ring.dash"
			/>
			<ellipse
				:cx="CENTER.x"
				:cy="CENTER.y"
				:rx="OUTER"
				ry="96"
				stroke-opacity=".14"
				:transform="`rotate(-23.4 ${CENTER.x} ${CENTER.y})`"
			/>
			<line
				v-for="(line, index) in MERIDIANS"
				:key="`m${index}`"
				:x1="line.x1"
				:y1="line.y1"
				:x2="line.x2"
				:y2="line.y2"
				stroke-opacity=".1"
			/>
			<line
				v-for="(tick, index) in TICKS"
				:key="`t${index}`"
				:x1="tick.x1"
				:y1="tick.y1"
				:x2="tick.x2"
				:y2="tick.y2"
				:stroke-opacity="tick.major ? .32 : .16"
			/>
		</g>
		<g
			class="compass-sky__stars"
			fill="currentColor"
		>
			<circle
				v-for="(star, index) in STARS"
				:key="`s${index}`"
				:cx="star.x"
				:cy="star.y"
				:r="star.r"
				:fill-opacity="star.opacity"
			/>
			<path
				v-for="(spark, index) in SPARKS"
				:key="`p${index}`"
				:d="sparkPath(spark.x, spark.y, spark.size)"
				:fill-opacity="spark.opacity"
			/>
		</g>
	</svg>
</template>

<script setup lang="ts">
// A fixed ornament: the same rings and stars on every page, never derived from the user's data.
const CENTER = {x: 960, y: 200}
const OUTER = 260

const RINGS = [
	{r: OUTER, opacity: .24, dash: undefined},
	{r: 238, opacity: .16, dash: '1 7'},
	{r: 182, opacity: .16, dash: undefined},
	{r: 114, opacity: .14, dash: undefined},
	{r: 46, opacity: .2, dash: undefined},
]

function polar(radius: number, degrees: number) {
	const angle = degrees * Math.PI / 180
	return {
		x: Math.round((CENTER.x + radius * Math.cos(angle)) * 10) / 10,
		y: Math.round((CENTER.y + radius * Math.sin(angle)) * 10) / 10,
	}
}

const MERIDIANS = [0, 30, 60, 90, 120, 150].map(degrees => {
	const from = polar(OUTER, degrees)
	const to = polar(OUTER, degrees + 180)
	return {x1: from.x, y1: from.y, x2: to.x, y2: to.y}
})

const TICKS = Array.from({length: 72}, (_, index) => {
	const degrees = index * 5
	const major = degrees % 30 === 0
	const inner = polar(OUTER, degrees)
	const outer = polar(OUTER + (major ? 14 : 7), degrees)
	return {x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y, major}
})

// A small linear congruential generator with a fixed seed: scattered, but identical on every render.
function seeded(seed: number) {
	let state = seed
	return () => {
		state = (state * 1664525 + 1013904223) % 4294967296
		return state / 4294967296
	}
}

const random = seeded(31)
const STARS = Array.from({length: 46}, () => ({
	x: Math.round(380 + random() * 800),
	y: Math.round(12 + random() * 336),
	r: Math.round((.6 + random() * 1.3) * 10) / 10,
	opacity: Math.round((.25 + random() * .55) * 100) / 100,
}))

const SPARKS = [
	{x: 1112, y: 62, size: 9, opacity: .7},
	{x: 742, y: 104, size: 6, opacity: .55},
	{x: 1046, y: 318, size: 5, opacity: .45},
	{x: 868, y: 34, size: 4, opacity: .5},
]

function sparkPath(x: number, y: number, size: number): string {
	const waist = size * .22
	return `M${x} ${y - size}L${x + waist} ${y - waist}L${x + size} ${y}L${x + waist} ${y + waist}` +
		`L${x} ${y + size}L${x - waist} ${y + waist}L${x - size} ${y}L${x - waist} ${y - waist}Z`
}
</script>

<style lang="scss" scoped>
.compass-sky {
	position: absolute;
	inset: 0;
	inline-size: 100%;
	block-size: 100%;
	color: var(--compass-star);
	pointer-events: none;
	// Fades out towards the start edge so the title and motto always sit on clear sky.
	mask-image: linear-gradient(to right, transparent 8%, #000000 62%);

	// The mask flips with the element, so the clear side follows the text.
	[dir='rtl'] & {
		transform: scaleX(-1);
	}

	@media print {
		display: none;
	}
}
</style>

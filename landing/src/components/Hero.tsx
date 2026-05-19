import { useState } from 'react';
import DownloadDropdown from './DownloadDropdown';

const GITHUB_RELEASES_URL = 'https://github.com/babyvibe/Deplao-releases';

const heroMetrics = [
	{ value: '10+', label: 'module', note: 'chat · crm · ai' },
	{ value: '50+', label: 'workflow mẫu', note: 'cài nhanh' },
	{ value: '24/7', label: 'automation', note: 'chạy nền' },
];

const heroScenarios = [
	{
		id: 'shop-online',
		tab: 'Shop online',
		audience: 'Shop online / TMĐT',
		trigger: 'Khách hỏi giá, hỏi tình trạng đơn hoặc cần báo phí ship',
		logic: 'AI hiểu ý định → tra CRM / POS / vận chuyển theo hội thoại hiện tại',
		action: 'Gửi báo giá, trạng thái đơn, ưu đãi và gắn nhãn để nuôi lead tiếp',
		outcome: 'Chốt đơn nhanh hơn mà không cần nhảy qua nhiều phần mềm khác nhau.',
		steps: [
			{ icon: '💬', label: 'Khách nhắn Zalo', group: 'Trigger' },
			{ icon: '🤖', label: 'AI hiểu nhu cầu', group: 'AI' },
			{ icon: '🛒', label: 'Tra POS / vận chuyển', group: 'Tích hợp' },
			{ icon: '🏷️', label: 'Gửi báo giá + gắn nhãn', group: 'Action' },
		],
		icon: '🛒',
		badge: 'Bán hàng',
		tone: 'bg-blue-50 border-blue-200 text-blue-700',
	},
	{
		id: 'sales',
		tab: 'Sales',
		audience: 'Sales / Telesales',
		trigger: 'Lead chưa phản hồi 4 giờ',
		logic: 'Workflow đọc trạng thái lead + kiểm tra lần tương tác cuối',
		action: 'Tự follow-up, lưu log CRM, nhắc nhân viên phụ trách',
		outcome: 'Giảm bỏ sót lead và giữ nhịp follow-up đồng đều cho toàn đội.',
		steps: [
			{ icon: '⏳', label: 'Lead im lặng 4 giờ', group: 'Trigger' },
			{ icon: '👥', label: 'Đọc trạng thái CRM', group: 'CRM' },
			{ icon: '⚙️', label: 'Workflow kiểm tra điều kiện', group: 'Logic' },
			{ icon: '📞', label: 'Follow-up + nhắc sales', group: 'Action' },
		],
		icon: '📞',
		badge: 'Follow-up',
		tone: 'bg-emerald-50 border-emerald-200 text-emerald-700',
	},
	{
		id: 'education',
		tab: 'Giáo dục',
		audience: 'Trung tâm đào tạo / Giáo dục',
		trigger: 'Đến lịch học, đổi lịch hoặc cần nhắc học viên / phụ huynh',
		logic: 'Lọc theo lớp, khóa học, ngày học và người phụ trách từng nhóm',
		action: 'Gửi nhắc lịch, thông báo thay đổi và chăm sóc học viên hàng loạt',
		outcome: 'Giảm công việc thủ công cho giáo vụ và giữ liên lạc ổn định với phụ huynh.',
		steps: [
			{ icon: '📅', label: 'Đến lịch học', group: 'Trigger' },
			{ icon: '🧩', label: 'Lọc theo lớp / khóa', group: 'Logic' },
			{ icon: '👨‍👩‍👧', label: 'Tách học viên / phụ huynh', group: 'CRM' },
			{ icon: '📣', label: 'Gửi nhắc lịch hàng loạt', group: 'Action' },
		],
		icon: '🎓',
		badge: 'Giáo dục',
		tone: 'bg-amber-50 border-amber-200 text-amber-700',
	},
	{
		id: 'spa-clinic',
		tab: 'Spa / Clinic',
		audience: 'Phòng khám / Spa / Làm đẹp',
		trigger: 'Lịch hẹn ngày mai hoặc sinh nhật khách',
		logic: 'Lọc danh sách theo ngày, gói dịch vụ và nhãn chăm sóc sau dịch vụ',
		action: 'Gửi nhắc lịch, chúc mừng sinh nhật và ưu đãi kéo khách quay lại',
		outcome: 'Tăng tỷ lệ khách quay lại và giữ trải nghiệm chăm sóc cá nhân hoá hơn.',
		steps: [
			{ icon: '🎂', label: 'Sinh nhật / lịch hẹn', group: 'Trigger' },
			{ icon: '🗂️', label: 'Lọc gói dịch vụ', group: 'Logic' },
			{ icon: '💎', label: 'Chọn ưu đãi phù hợp', group: 'CRM' },
			{ icon: '🏥', label: 'Nhắc lịch + chăm sóc lại', group: 'Action' },
		],
		icon: '🏥',
		badge: 'CSKH',
		tone: 'bg-violet-50 border-violet-200 text-violet-700',
	},
	{
		id: 'fnb',
		tab: 'F&B',
		audience: 'F&B / Nhà hàng / Quán ăn',
		trigger: 'Khách đặt bàn, đặt món hoặc đến ngày ưu đãi đặc biệt',
		logic: 'Tra trạng thái đặt bàn, lịch sử mua và nhóm khách thân thiết',
		action: 'Xác nhận đơn, gửi ưu đãi phù hợp và nhắc khách quay lại đúng dịp',
		outcome: 'Giữ tương tác đều với khách quen và tự động hoá phần nhắc món/ưu đãi.',
		steps: [
			{ icon: '🍽️', label: 'Đặt bàn / đặt món', group: 'Trigger' },
			{ icon: '🧾', label: 'Tra lịch sử mua', group: 'CRM' },
			{ icon: '🎯', label: 'Chọn ưu đãi theo dịp', group: 'Logic' },
			{ icon: '📩', label: 'Xác nhận + nhắc quay lại', group: 'Action' },
		],
		icon: '🍜',
		badge: 'F&B',
		tone: 'bg-rose-50 border-rose-200 text-rose-700',
	},
	{
		id: 'agency',
		tab: 'Agency',
		audience: 'Agency / Freelancer Marketing',
		trigger: 'Lead mới vào nhiều tài khoản Zalo của từng client',
		logic: 'Phân loại nguồn lead, gắn nhãn theo chiến dịch và tách từng client',
		action: 'Tự nurture lead, báo cáo kết quả và giảm bỏ sót tin nhắn cho từng khách hàng',
		outcome: 'Quản lý nhiều client trên cùng một workspace mà vẫn tách luồng rõ ràng.',
		steps: [
			{ icon: '📥', label: 'Lead mới vào nhiều page', group: 'Trigger' },
			{ icon: '🏷️', label: 'Gắn nhãn theo client', group: 'CRM' },
			{ icon: '🪄', label: 'Workflow nurture tự động', group: 'Workflow' },
			{ icon: '📊', label: 'Báo cáo theo chiến dịch', group: 'Analytics' },
		],
		icon: '📣',
		badge: 'Agency',
		tone: 'bg-cyan-50 border-cyan-200 text-cyan-700',
	},
];

const heroPills = [
	'Đa tài khoản Zalo',
	'Inbox tập trung',
	'CRM khách hàng',
	'AI Assistant',
	'Workflow tự động',
	'Tích hợp bán hàng',
	'Nhân viên & workspace',
];

const Hero: React.FC = () => {
	const [activeScenarioId, setActiveScenarioId] = useState(heroScenarios[0].id);
	const activeScenario = heroScenarios.find((scenario) => scenario.id === activeScenarioId) ?? heroScenarios[0];

	return (
		<section id="hero" className="relative overflow-hidden px-4 pb-16 pt-28 sm:px-6 sm:pb-20 sm:pt-32">
			<div className="mx-auto grid max-w-7xl items-start gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:gap-10">
				<div className="relative z-10 pt-0 sm:pt-2">
					<div className="orbit-badge mb-6 aos-element">
						<span className="dot-pulse" />
						Workspace CSKH & Automation Zalo
					</div>

					<h1 className="aos-element delay-1 mb-5 max-w-[12ch] text-4xl font-black leading-[0.98] tracking-tight text-slate-950 sm:max-w-[14ch] sm:text-5xl lg:text-7xl">
						Quản lý Zalo chuyên nghiệp <span className="gradient-text">Đa tài khoản, CRM, Workflow và  AI Assistant</span>
					</h1>

					<p className="aos-element delay-2 mb-7 max-w-2xl text-base leading-relaxed text-slate-600 sm:text-md md:text-md">
						Phần mềm giúp bạn phản hồi nhanh hơn, chuyển đổi cao hơn, tự động chăm sóc khách hàng,
						AI xử lý 24/7, giảm tải cho đội ngũ.
						Vận hành gọn nhẹ, không bỏ sót khách hàng.
					</p>

					<div className="aos-element delay-2 mb-8 flex flex-wrap gap-2.5 sm:gap-3">
						{heroPills.map((chip) => (
							<span key={chip} className="hero-pill">
								{chip}
							</span>
						))}
					</div>

					<div className="hero-cta-row aos-element delay-3 mb-8 sm:mb-10 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
						<DownloadDropdown
							label="Tải xuống"
							variant="primary"
							align="left"
							className="hero-cta-button px-6 py-4 text-base sm:px-8"
							wrapperClassName="hero-download-trigger"
						/>
						<a
							href={GITHUB_RELEASES_URL}
							target="_blank"
							rel="noreferrer"
							className="btn-secondary hero-cta-button hero-github-button flex items-center gap-2 text-base no-underline"
						>
							<svg className="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
								<path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.009-.866-.014-1.7-2.782.605-3.369-1.344-3.369-1.344-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.071 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.091-.647.349-1.088.635-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.389-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.748-1.026 2.748-1.026.546 1.378.203 2.397.1 2.65.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.31.678.922.678 1.858 0 1.341-.012 2.422-.012 2.751 0 .268.18.579.688.481A10.019 10.019 0 0022 12.017C22 6.484 17.523 2 12 2z" />
							</svg>
							<span>GitHub</span>
						</a>
						<button
							onClick={() => document.getElementById('features')?.scrollIntoView({ behavior: 'smooth' })}
							className="btn-secondary hero-cta-button flex cursor-pointer items-center gap-2 bg-transparent text-base"
						>
							<svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path
									strokeLinecap="round"
									strokeLinejoin="round"
									strokeWidth={2}
									d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
							Tính năng
						</button>
					</div>

					<div className="aos-element delay-4 grid gap-3 sm:grid-cols-3 md:gap-4">
						{heroMetrics.map((metric) => (
							<div key={metric.label} className="metric-tile">
								<div className="text-3xl font-black text-slate-950">{metric.value}</div>
								<div className="mt-1 text-sm font-semibold text-slate-800">{metric.label}</div>
								<div className="mt-1 text-xs text-slate-500">{metric.note}</div>
							</div>
						))}
					</div>
				</div>

				<div className="relative min-w-0 aos-element delay-3 lg:pl-20">
					<div className="command-panel rounded-[1.6rem] p-3.5 sm:rounded-[2rem] sm:p-4 md:p-5">
						<div className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-4">
							<div>
								<div className="mini-kicker mb-2">
									<span className="signal-dot" />
									Workflow live preview
								</div>
								<h3 className="max-w-[24rem] text-lg font-bold text-slate-950 sm:text-xl">Nhiều use case vận hành thực tế trên cùng một workspace</h3>
							</div>
						</div>

						<div className="workflow-preview">
							<div className="workflow-tabs relative z-10 mb-4">
								{heroScenarios.map((scenario) => (
									<button
										key={scenario.id}
										type="button"
										onClick={() => setActiveScenarioId(scenario.id)}
										className={`workflow-tab ${activeScenario.id === scenario.id ? 'is-active' : ''}`}
									>
										<span className="workflow-tab-icon">{scenario.icon}</span>
										<span>{scenario.tab}</span>
									</button>
								))}
							</div>

							<div key={activeScenario.id} className="workflow-tab-panel workflow-live-spotlight workflow-node workflow-node-dark">
								<div className="mb-4 flex flex-wrap items-start justify-between gap-3">
									<div>
										<div className="inline-flex rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-white/80">
											{activeScenario.badge}
										</div>
										<div className="mt-3 text-lg font-black text-white md:text-xl">
											{activeScenario.audience}
										</div>
									</div>
									<div className="workflow-live-orb">
										<span>{activeScenario.icon}</span>
									</div>
								</div>

								<div className="workflow-step-flow mb-4">
									{activeScenario.steps.map((step, index) => (
										<div key={step.label} className="workflow-step-flow-item">
											<div className="workflow-step-card">
												<div className="workflow-step-icon">{step.icon}</div>
												<div className="workflow-step-copy">
													<div className="workflow-step-group">{step.group}</div>
													<div className="workflow-step-label">{step.label}</div>
												</div>
											</div>
											{index < activeScenario.steps.length - 1 && <div className="workflow-step-arrow">→</div>}
										</div>
									))}
								</div>

								<div className="grid gap-3 md:grid-cols-[0.9fr_1.05fr_1.2fr]">
									<div className="feature-proof-dark">
										<div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
											Trigger
										</div>
										<div className="mt-2 text-sm leading-relaxed text-white/88">
											{activeScenario.trigger}
										</div>
									</div>

									<div className="feature-proof-dark">
										<div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
											Logic
										</div>
										<div className="mt-2 text-sm leading-relaxed text-white/88">
											{activeScenario.logic}
										</div>
									</div>

									<div className="feature-proof-dark">
										<div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
											Action
										</div>
										<div className="mt-2 text-sm leading-relaxed text-white/88">
											{activeScenario.action}
										</div>
									</div>
								</div>

								<div className="workflow-live-result mt-4">
									<div className="text-[10px] font-bold uppercase tracking-[0.16em] text-white/60">
										Outcome
									</div>
									<div className="mt-2 text-sm leading-relaxed text-white/88">
										{activeScenario.outcome}
									</div>
								</div>
							</div>

						</div>
					</div>
				</div>
			</div>
		</section>
	);
};

export default Hero;


import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { RecoveryCarrierParkForm } from "@/components/RecoveryCarrierParkForm";
import { TaskChatPausedTakeover } from "@/components/task-chat/TaskChatPausedTakeover";
import { recoveryCarrierParkFixture } from "@/fixtures/recoveryCarrierParkFixture";

function CarrierParkExample({ initialPark = false, stale = false, reject = false }: { initialPark?: boolean; stale?: boolean; reject?: boolean }) {
  const [reason, setReason] = useState(initialPark ? "The board rejected further repair." : "");
  const [error, setError] = useState<string | null>(null);
  const [released, setReleased] = useState(false);
  return <div className="max-w-xl p-4">
    {reason && !released ? <TaskChatPausedTakeover scope="leaf" carrierPark={{ state: stale ? "stale" : "accepted", reason }}
      onResume={() => setReleased(true)} /> : released ? <p role="status">Board park released. Source recovery is still escalated and unresolved.</p> :
      <RecoveryCarrierParkForm candidate={recoveryCarrierParkFixture} error={error} onPark={input => {
        if (reject) setError("Carrier ownership changed. Refresh the task before choosing a disposition.");
        else setReason(input.reason);
      }} />}
  </div>;
}
const meta = { title: "Tasks/Recovery carrier park", component: CarrierParkExample,
  parameters: { layout: "padded", docs: { description: { component: "Production acceptance form and manual-pause takeover. Story actions are local fixtures; real PostgreSQL route tests prove persistence and action immutability." } } } } satisfies Meta<typeof CarrierParkExample>;
export default meta;
type Story = StoryObj<typeof meta>;
export const AcceptanceAndRelease: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Park recovery carrier" }));
    const accept = canvas.getByRole("button", { name: "Accept unresolved recovery and park" });
    await expect(accept).toBeDisabled();
    await userEvent.selectOptions(canvas.getByLabelText("Historical board decision"), recoveryCarrierParkFixture.decisions[0].id);
    await userEvent.type(canvas.getByLabelText("Reason for accepting unresolved recovery"), "The board requires this recovery to remain unresolved.");
    await userEvent.click(accept);
    await expect(canvas.getByRole("heading", { name: "Parked by board — recovery intentionally unresolved" })).toBeVisible();
    await expect(canvas.getByText(/Manual board release only/)).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Release board park" }));
    await expect(canvas.getByRole("status")).toHaveTextContent("Source recovery is still escalated and unresolved.");
  },
};
export const Parked: Story = { args: { initialPark: true } };
export const StaleAcceptance: Story = { args: { initialPark: true, stale: true } };
export const OwnershipConflict: Story = { args: { reject: true } };
export const TouchDecisionControl: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Park recovery carrier" }));
    const decision = canvas.getByRole("combobox", { name: "Historical board decision" });
    // Keep editable controls at the touch-safe base size to avoid focus zoom.
    await expect(Number.parseFloat(getComputedStyle(decision).fontSize)).toBeGreaterThanOrEqual(16);
    const accept = canvas.getByRole("button", { name: "Accept unresolved recovery and park" });
    await expect(accept.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth);
  },
};

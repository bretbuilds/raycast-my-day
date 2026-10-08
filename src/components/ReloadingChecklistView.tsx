import { useNavigation } from "@raycast/api";
import type { ChecklistFile } from "../lib/store.ts";
import type { ChecklistSession } from "../lib/use-checklists.ts";
import { ChecklistView } from "./ChecklistView.tsx";
import { ReloadSessionAfterPop, ScheduleFromChecklist } from "./ScheduleFromChecklist.tsx";

/** ChecklistView with Schedule Work Block wired for the Checklists command. */
export function ReloadingChecklistView(props: { session: ChecklistSession; file: ChecklistFile }) {
  const { push } = useNavigation();
  return (
    <ChecklistView
      session={props.session}
      file={props.file}
      onSchedule={(task, file) =>
        push(
          <ReloadSessionAfterPop session={props.session}>
            <ScheduleFromChecklist task={task} file={file} />
          </ReloadSessionAfterPop>,
        )
      }
    />
  );
}

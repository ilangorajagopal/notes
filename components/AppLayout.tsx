import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useRouter } from 'next/router';
import { toast } from 'react-toastify';
import type { User } from '@supabase/supabase-js';
import {
  useStore,
  store,
  NoteTreeItem,
  getNoteTreeItem,
  Notes,
} from 'lib/store';
import supabase from 'lib/supabase';
import {
  Note,
  Subscription,
  SubscriptionStatus,
  User as DbUser,
} from 'types/supabase';
import { useAuth } from 'utils/useAuth';
import useHotkeys from 'utils/useHotkeys';
import { MAX_NUM_OF_BASIC_NOTES, PlanId } from 'constants/pricing';
import { isMobile } from 'utils/device';
import Sidebar from './sidebar/Sidebar';
import FindOrCreateModal from './FindOrCreateModal';
import PageLoading from './PageLoading';
import SettingsModal from './settings/SettingsModal';
import UpgradeModal from './UpgradeModal';

type Props = {
  children: ReactNode;
  className?: string;
};

export default function AppLayout(props: Props) {
  const { children, className = '' } = props;
  const { user, isLoaded } = useAuth();
  const router = useRouter();

  const [isPageLoaded, setIsPageLoaded] = useState(false);
  const setNotes = useStore((state) => state.setNotes);
  const setNoteTree = useStore((state) => state.setNoteTree);
  const initData = useCallback(async () => {
    if (!user) {
      return;
    }

    const { data: notes } = await supabase
      .from<Note>('notes')
      .select('id, title, content, created_at, updated_at')
      .eq('user_id', user.id)
      .order('title');

    // Redirect to most recent note or first note in database
    if (router.pathname === '/app') {
      const openNoteIds = store.getState().openNoteIds;
      if (
        openNoteIds.length > 0 &&
        notes &&
        notes.findIndex((note) => note.id === openNoteIds[0]) > -1
      ) {
        router.replace(`/app/note/${openNoteIds[0]}`);
        return;
      } else if (notes && notes.length > 0) {
        router.replace(`/app/note/${notes[0].id}`);
        return;
      }
    }

    if (!notes) {
      setIsPageLoaded(true);
      return;
    }

    // Set notes
    const notesAsObj = notes.reduce<Record<Note['id'], Note>>((acc, note) => {
      acc[note.id] = note;
      return acc;
    }, {});
    setNotes(notesAsObj);

    // Set note tree
    const { data: userData } = await supabase
      .from<DbUser>('users')
      .select('note_tree')
      .eq('id', user.id)
      .single();
    if (userData?.note_tree) {
      const noteTree: NoteTreeItem[] = [...userData.note_tree];
      // This is a sanity check for removing notes in the noteTree that do not exist
      removeNonexistentNotes(noteTree, notesAsObj);
      // If there are notes that are not in the note tree, add them
      // This is a sanity check to make sure there are no orphaned notes
      for (const note of notes) {
        if (getNoteTreeItem(noteTree, note.id) === null) {
          noteTree.push({ id: note.id, children: [], collapsed: true });
        }
      }
      // Use the note tree saved in the database
      setNoteTree(noteTree);
    } else {
      // No note tree in database, just use notes
      setNoteTree(
        notes.map((note) => ({ id: note.id, children: [], collapsed: true }))
      );
    }

    setIsPageLoaded(true);
  }, [user, router, setNotes, setNoteTree]);

  useEffect(() => {
    if (isLoaded && !user) {
      // Redirect to login page if there is no user logged in
      router.replace('/login');
    } else if (!isPageLoaded && isLoaded && user) {
      // Initialize data if there is a user and the data has not been initialized yet
      initData();
    }
  }, [router, user, isLoaded, isPageLoaded, initData]);

  const setBillingDetails = useStore((state) => state.setBillingDetails);
  const initBillingDetails = useCallback(
    async (user: User) => {
      const { data } = await supabase
        .from<Subscription>('subscriptions')
        .select(
          'plan_id, subscription_status, frequency, current_period_end, cancel_at_period_end'
        )
        .eq('user_id', user.id)
        .maybeSingle();

      if (data) {
        setBillingDetails({
          planId:
            data.subscription_status === SubscriptionStatus.Active
              ? data.plan_id
              : PlanId.Basic,
          frequency: data.frequency,
          currentPeriodEnd: new Date(data.current_period_end),
          cancelAtPeriodEnd: data.cancel_at_period_end,
        });
      }
    },
    [setBillingDetails]
  );

  useEffect(() => {
    if (!user) {
      return;
    }
    initBillingDetails(user);
  }, [initBillingDetails, user]);

  const [isFindOrCreateModalOpen, setIsFindOrCreateModalOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const darkMode = useStore((state) => state.darkMode);
  const setIsSidebarOpen = useStore((state) => state.setIsSidebarOpen);
  const setIsPageStackingOn = useStore((state) => state.setIsPageStackingOn);

  const billingDetails = useStore((state) => state.billingDetails);
  const numOfNotes = useStore((state) => Object.keys(state.notes).length);
  const isUpgradeModalOpen = useStore((state) => state.isUpgradeModalOpen);
  const setIsUpgradeModalOpen = useStore(
    (state) => state.setIsUpgradeModalOpen
  );

  const upsertNote = useStore((state) => state.upsertNote);
  const updateNote = useStore((state) => state.updateNote);
  const deleteNote = useStore((state) => state.deleteNote);

  useEffect(() => {
    if (isMobile()) {
      setIsSidebarOpen(false);
      setIsPageStackingOn(false);
    }
  }, [setIsSidebarOpen, setIsPageStackingOn]);

  useEffect(() => {
    if (!user) {
      return;
    }

    // Subscribe to changes on the notes table for the logged in user
    const subscription = supabase
      .from<Note>(`notes:user_id=eq.${user.id}`)
      .on('*', (payload) => {
        if (payload.eventType === 'INSERT') {
          upsertNote(payload.new);
        } else if (payload.eventType === 'UPDATE') {
          // Don't update the note if it is currently open
          const openNoteIds = store.getState().openNoteIds;
          if (!openNoteIds.includes(payload.new.id)) {
            updateNote(payload.new);
          }
        } else if (payload.eventType === 'DELETE') {
          deleteNote(payload.old.id);
        }
      })
      .subscribe();

    return () => {
      subscription.unsubscribe();
    };
  }, [user, upsertNote, updateNote, deleteNote]);

  const hotkeys = useMemo(
    () => [
      {
        hotkey: 'mod+p',
        callback: () => setIsFindOrCreateModalOpen((isOpen) => !isOpen),
      },
    ],
    [setIsFindOrCreateModalOpen]
  );
  useHotkeys(hotkeys);

  useEffect(() => {
    const {
      query: { checkout_session_id: checkoutSessionId, ...otherQueryParams },
    } = router;

    if (checkoutSessionId) {
      // Show toast if the user successfully subscribed to Notabase
      toast.success('You have successfully subscribed to Notabase! 🎉');
      router.push(
        { pathname: router.pathname, query: otherQueryParams },
        undefined,
        { shallow: true }
      );
    }
  }, [router]);

  if (!isPageLoaded) {
    return <PageLoading />;
  }

  return (
    <div
      id="app-container"
      className={`flex h-screen ${darkMode ? 'dark' : ''} ${className}`}
    >
      <Sidebar
        setIsFindOrCreateModalOpen={setIsFindOrCreateModalOpen}
        setIsSettingsOpen={setIsSettingsOpen}
      />
      <div className="relative flex flex-col flex-1 overflow-y-hidden">
        {billingDetails.planId === PlanId.Basic &&
        numOfNotes >= MAX_NUM_OF_BASIC_NOTES - 10 ? (
          <button
            className="block w-full py-1 font-semibold text-center bg-yellow-300"
            onClick={() => setIsUpgradeModalOpen(true)}
          >
            You have {numOfNotes < MAX_NUM_OF_BASIC_NOTES ? 'almost' : ''}{' '}
            reached your {MAX_NUM_OF_BASIC_NOTES} note limit. Upgrade now for
            unlimited notes and uninterrupted access.
          </button>
        ) : null}
        {children}
      </div>
      {isSettingsOpen ? <SettingsModal setIsOpen={setIsSettingsOpen} /> : null}
      {isFindOrCreateModalOpen ? (
        <FindOrCreateModal setIsOpen={setIsFindOrCreateModalOpen} />
      ) : null}
      {isUpgradeModalOpen ? <UpgradeModal /> : null}
    </div>
  );
}

const removeNonexistentNotes = (tree: NoteTreeItem[], notes: Notes) => {
  for (let i = 0; i < tree.length; i++) {
    const item = tree[i];
    if (!notes[item.id]) {
      tree.splice(i, 1);
    } else if (item.children.length > 0) {
      removeNonexistentNotes(item.children, notes);
    }
  }
};
